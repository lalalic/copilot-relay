#!/usr/bin/env node
/**
 * Copilot CLI Pool Relay Server v2
 * 
 * Features:
 *   - Session pooling with lazy expansion
 *   - Multi-workspace: one CLI process per workspace (appId routing)
 *   - Session hold: ask_user → on-hold state with configurable timeout
 *   - Client pinning: clientId → session mapping for reconnection
 *   - Workspace snapshots: zip session state on hold expiry, send to client
 *   - RPC ID remapping to avoid collisions
 * 
 * Architecture:
 *   iOS App → WebSocket → this relay → CLI-1 (cwd: /apps/app1) → N sessions
 *                                    → CLI-2 (cwd: /apps/app2) → N sessions
 * 
 * Intercepted methods:
 *   session.create    → assign pool session (with appId + clientId routing)
 *   session.resume    → treat as session.create (with clientId reconnection)  
 *   session.disconnect/destroy → release session (or hold if ask_user pending)
 *   session.list      → return []
 *   Everything else   → forward to CLI with remapped RPC IDs
 * 
 * Usage:
 *   node relay-server.js
 *   PORT=8765 POOL_SIZE=3 node relay-server.js
 *   WORKSPACES=/path/to/workspaces.json node relay-server.js
 */

const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Config ---
const PORT = parseInt(process.env.PORT) || 8765;
const CLI_PATH = process.env.CLI_PATH || findCopilotCLI();
const POOL_SIZE = parseInt(process.env.POOL_SIZE) || 3;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MODEL = process.env.MODEL || 'gpt-4.1';
const HOLD_TIMEOUT = parseInt(process.env.HOLD_TIMEOUT) || 10 * 60 * 1000; // 10 minutes
const WORKSPACES_CONFIG = process.env.WORKSPACES || null;

// --- Agent Config ---

// Agent loop instructions injected into last_instructions section
const AGENT_LOOP_CONTENT = `IMPORTANT: You are an autonomous agent running in an infinite loop.
- Use the \`send_response\` tool to deliver your responses to the user. Do NOT just end your turn.
- Use the \`ask_user\` tool when you need more information or when all tasks are done to ask what to do next.
- Always use one of these tools before your turn ends.`;

/**
 * Build a systemMessage param for session.create using customize mode.
 * Supports multiple input formats:
 *   - undefined/null → customize with just agent loop in last_instructions
 *   - string → customize with string as content + agent loop in last_instructions
 *   - object { mode: 'customize', sections: {...}, content?: '...' } → merge sections + agent loop
 *   - object { mode: 'replace', content: '...' } → replace with content + agent loop appended
 *   - object (append/default) → customize with content + agent loop
 *
 * Available section IDs: identity, tone, tool_efficiency, environment_context,
 * code_change_rules, guidelines, safety, tool_instructions, custom_instructions, last_instructions.
 * Each section supports: replace, remove, append, prepend.
 */
function buildSessionSystemMessage(baseConfig) {
    const agentSection = { action: 'append', content: AGENT_LOOP_CONTENT };

    // No config → just inject agent loop
    if (!baseConfig) {
        return { mode: 'customize', sections: { last_instructions: agentSection } };
    }

    // String → use as content with agent loop
    if (typeof baseConfig === 'string') {
        return {
            mode: 'customize',
            sections: { last_instructions: agentSection },
            content: baseConfig,
        };
    }

    // Object → merge based on mode
    if (typeof baseConfig === 'object') {
        const mode = baseConfig.mode;

        if (mode === 'replace') {
            // Respect replace but append agent loop to content
            return {
                mode: 'replace',
                content: (baseConfig.content || '') + '\n\n' + AGENT_LOOP_CONTENT,
            };
        }

        if (mode === 'customize') {
            // Merge client sections with agent loop in last_instructions
            const sections = { ...(baseConfig.sections || {}) };

            if (sections.last_instructions && sections.last_instructions.content) {
                // Merge with existing last_instructions
                const existing = sections.last_instructions;
                sections.last_instructions = {
                    action: existing.action || 'append',
                    content: existing.content + '\n\n' + AGENT_LOOP_CONTENT,
                };
            } else {
                sections.last_instructions = agentSection;
            }

            return {
                mode: 'customize',
                sections,
                ...(baseConfig.content ? { content: baseConfig.content } : {}),
            };
        }

        // Default/append mode
        return {
            mode: 'customize',
            sections: { last_instructions: agentSection },
            ...(baseConfig.content ? { content: baseConfig.content } : {}),
        };
    }

    // Fallback
    return { mode: 'customize', sections: { last_instructions: agentSection } };
}

const AGENT_TOOLS = [
    {
        name: 'send_response',
        description: 'Send a response message to the user. Use this to deliver results instead of ending your turn.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The response message to send to the user' },
            },
            required: ['message'],
        },
        skipPermission: true,
    },
    {
        name: 'ask_user',
        description: 'Ask the user a question and wait for their answer. Use this when you need more information or when all tasks are completed to ask what to do next.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The question to ask the user' },
            },
            required: ['question'],
        },
        skipPermission: true,
    },
];

function findCopilotCLI() {
    const candidates = ['/opt/homebrew/bin/copilot', '/usr/local/bin/copilot'];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    console.error('Copilot CLI not found. Set CLI_PATH env var.');
    process.exit(1);
}

function log(level, ...args) {
    if (level === 'debug' && LOG_LEVEL !== 'debug') return;
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] [${level}]`, ...args);
}

// --- Content-Length Frame Parser ---
class FrameParser {
    buffer = Buffer.alloc(0);

    feed(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        const messages = [];
        while (true) {
            const hdrEnd = this.buffer.indexOf('\r\n\r\n');
            if (hdrEnd < 0) break;
            const m = this.buffer.slice(0, hdrEnd).toString().match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                this.buffer = this.buffer.slice(hdrEnd + 4);
                continue;
            }
            const bodyLen = parseInt(m[1]);
            const totalLen = hdrEnd + 4 + bodyLen;
            if (this.buffer.length < totalLen) break;
            try {
                messages.push(JSON.parse(this.buffer.slice(hdrEnd + 4, totalLen).toString()));
            } catch (e) {
                log('warn', 'Bad JSON in frame:', e.message);
            }
            this.buffer = this.buffer.slice(totalLen);
        }
        return messages;
    }
}

function frame(obj) {
    const json = JSON.stringify(obj);
    return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

// --- Workspace Snapshot (tar.gz) ---
function zipDirectory(dirPath) {
    try {
        const buf = execSync(`tar -czf - -C "${dirPath}" .`, { maxBuffer: 50 * 1024 * 1024 });
        return buf;
    } catch (e) {
        log('error', `Failed to zip ${dirPath}: ${e.message}`);
        return null;
    }
}

function unzipToDirectory(buffer, dirPath) {
    try {
        fs.mkdirSync(dirPath, { recursive: true });
        const tmpFile = path.join(os.tmpdir(), `relay-snapshot-${Date.now()}.tar.gz`);
        fs.writeFileSync(tmpFile, buffer);
        execSync(`tar -xzf "${tmpFile}" -C "${dirPath}"`);
        fs.unlinkSync(tmpFile);
        return true;
    } catch (e) {
        log('error', `Failed to unzip to ${dirPath}: ${e.message}`);
        return false;
    }
}

/**
 * Extract conversation context from a session workspace's events.jsonl.
 * Parses the JSONL file and extracts user messages and assistant tool responses
 * (send_response content). Returns a formatted context string for injection
 * into a new session, or null if no meaningful context found.
 */
function extractConversationContext(workspacePath) {
    const eventsPath = path.join(workspacePath, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return null;

    try {
        const raw = fs.readFileSync(eventsPath, 'utf-8');
        const lines = raw.trim().split('\n').filter(l => l.trim());
        const turns = [];

        for (const line of lines) {
            try {
                const evt = JSON.parse(line);
                if (evt.type === 'user.message' && evt.data?.content) {
                    turns.push(`User: ${evt.data.content}`);
                } else if (evt.type === 'assistant.message' && evt.data?.toolRequests) {
                    for (const req of evt.data.toolRequests) {
                        if (req.name === 'send_response') {
                            const args = typeof req.arguments === 'string'
                                ? JSON.parse(req.arguments) : req.arguments;
                            if (args?.message) {
                                turns.push(`Assistant: ${args.message}`);
                            }
                        }
                    }
                }
            } catch { /* skip malformed lines */ }
        }

        if (turns.length === 0) return null;

        // Limit context to last 20 turns to avoid token overload
        const recent = turns.slice(-20);
        return `[Previous conversation context restored from snapshot]\n${recent.join('\n')}`;
    } catch (e) {
        log('error', `Failed to extract context from ${eventsPath}: ${e.message}`);
        return null;
    }
}

// --- Pool Proxy (one per workspace/app) ---
class PoolProxy {
    constructor(config = {}) {
        this.appId = config.appId || 'default';
        this.cwd = config.cwd || os.homedir();
        this.poolSize = config.poolSize || POOL_SIZE;
        this.model = config.model || MODEL;
        this.systemMessage = config.systemMessage || process.env.AGENT_INSTRUCTIONS || undefined;
        this.extraCliFlags = config.extraCliFlags || [];

        this.cli = null;
        this.parser = new FrameParser();
        this.pool = new Map();            // sessionId → PoolEntry
        this.available = [];              // sessionIds ready to assign
        this.pendingRequests = new Map(); // relayId → RequestInfo
        this.sessionToWs = new Map();     // sessionId → ws
        this.clientPins = new Map();      // clientId → sessionId (for on-hold sessions)
        this.clientSnapshots = new Map(); // clientId → { buffer, timestamp }
        this.nextId = 100000;
    }

    async start() {
        log('info', `[${this.appId}] CLI: ${CLI_PATH}, cwd: ${this.cwd}`);
        log('info', `[${this.appId}] Pool size: ${this.poolSize}`);

        this.cli = spawn(CLI_PATH, ['--headless', '--stdio', '--no-auto-update', ...this.extraCliFlags], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: this.cwd,
        });
        log('info', `[${this.appId}] CLI started (PID: ${this.cli.pid})`);

        this.cli.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg) log('debug', `[${this.appId}] CLI stderr: ${msg}`);
        });

        this.cli.on('close', (code) => {
            log('error', `[${this.appId}] CLI exited with code ${code}`);
        });

        this.cli.stdout.on('data', (data) => {
            for (const msg of this.parser.feed(data)) {
                this.routeFromCli(msg);
            }
        });

        // Pre-warm pool
        const promises = [];
        for (let i = 0; i < this.poolSize; i++) {
            promises.push(this.createPoolSession(`${this.appId}-pool-${i}`));
        }
        await Promise.all(promises);
        log('info', `[${this.appId}] Pool ready: ${this.available.length} sessions`);
    }

    createPoolSession(sid, extraTools, extraSystemMessage) {
        return new Promise((resolve, reject) => {
            if (!this.pool.has(sid)) {
                this.pool.set(sid, {
                    state: 'creating',
                    ws: null,
                    clientId: null,
                    holdInfo: null,
                    holdTimer: null,
                    workspacePath: null,
                });
            } else {
                this.pool.get(sid).state = 'creating';
            }
            const id = this.nextId++;
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Timeout creating session ${sid}`));
            }, 30000);

            this.pendingRequests.set(id, {
                ws: null, clientId: null, type: 'pool-create', sid,
                resolve: (result) => {
                    clearTimeout(timeout);
                    const entry = this.pool.get(sid);
                    if (entry && result?.workspacePath) {
                        entry.workspacePath = result.workspacePath;
                    }
                    resolve();
                },
            });

            // Merge AGENT_TOOLS with client-provided tools (deduplicate by name)
            const mergedTools = [...AGENT_TOOLS];
            if (extraTools?.length) {
                const existing = new Set(mergedTools.map(t => t.name));
                for (const t of extraTools) {
                    if (!existing.has(t.name)) mergedTools.push(t);
                }
            }

            // Use client system message if provided, otherwise default
            const sysMsg = extraSystemMessage || buildSessionSystemMessage(this.systemMessage);

            this.cli.stdin.write(frame({
                jsonrpc: '2.0', id,
                method: 'session.create',
                params: {
                    sessionId: sid,
                    model: this.model,
                    infiniteSessions: { enabled: true, backgroundCompactionThreshold: 0.80 },
                    requestPermission: true,
                    systemMessage: sysMsg,
                    tools: mergedTools,
                },
            }));
        });
    }

    /**
     * Re-create a pool session with client-specific tools.
     * Returns the new sessionId (since the CLI session uses a new ID).
     */
    async recreatePoolSession(oldSid, clientTools, clientSystemMessage) {
        // Generate a new session ID for the CLI
        const newSid = `${this.appId}-pool-${this.pool.size}`;

        // Remove old entry from pool 
        this.pool.delete(oldSid);
        this.sessionToWs.delete(oldSid);

        // Create new session with merged tools
        await this.createPoolSession(newSid, clientTools, clientSystemMessage);

        // Remove from available list (caller will set it active)
        const availIdx = this.available.indexOf(newSid);
        if (availIdx >= 0) this.available.splice(availIdx, 1);

        log('info', `[${this.appId}] Recreated ${oldSid} → ${newSid} with ${clientTools.length} client tools`);
        return newSid;
    }

    // --- CLI → Client routing ---
    routeFromCli(msg) {
        log('debug', `[${this.appId}] CLI →`, JSON.stringify(msg).slice(0, 200));

        // RPC response: match by tracked relay ID
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const req = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);

            if (req.type === 'pool-create') {
                const entry = this.pool.get(req.sid);
                entry.state = 'available';
                this.available.push(req.sid);
                log('info', `[${this.appId}] Session ${req.sid} created`);
                req.resolve?.(msg.result);
                return;
            }

            if (req.type === 'hold-expire') {
                log('debug', `[${this.appId}] Hold expire ack`);
                return;
            }

            if (req.type === 'context-recovery') {
                log('debug', `[${this.appId}] Context recovery send ack`);
                return;
            }

            // Forward to client with original ID
            if (req.ws?.readyState === 1) {
                msg.id = req.clientId;
                req.ws.send(frame(msg));
            }
            return;
        }

        // Notification: route by sessionId
        const sid = msg.params?.sessionId;
        if (sid) {
            const entry = this.pool.get(sid);

            // Intercept ask_user tool call → mark on-hold
            if (msg.params?.event?.type === 'external_tool.requested' &&
                msg.params.event.data?.toolName === 'ask_user') {
                if (entry) {
                    entry.state = 'on-hold';
                    entry.holdInfo = {
                        requestId: msg.params.event.data.requestId,
                        question: msg.params.event.data.arguments,
                        timestamp: Date.now(),
                    };
                    log('info', `[${this.appId}] Session ${sid} on-hold (ask_user)`);
                }
            }

            // Intercept tool completion → clear hold only if it was the pending ask_user
            if (msg.params?.event?.type === 'external_tool.completed') {
                if (entry?.state === 'on-hold' && entry.holdInfo?.requestId) {
                    // Only clear hold if THIS tool completion matches the pending ask_user
                    const completedReqId = msg.params.event.data?.requestId;
                    if (completedReqId === entry.holdInfo.requestId) {
                        entry.state = 'active';
                        entry.holdInfo = null;
                        log('info', `[${this.appId}] Session ${sid} resumed from on-hold`);
                    }
                }
            }

            const ws = this.sessionToWs.get(sid);
            if (ws?.readyState === 1) {
                ws.send(frame(msg));
            } else {
                log('debug', `[${this.appId}] No client for ${sid}, discarding`);
            }
            return;
        }

        log('debug', `[${this.appId}] Unroutable:`, JSON.stringify(msg).slice(0, 200));
    }

    // --- Client → CLI routing ---
    async handleClientMessage(ws, msg) {
        log('debug', `[${this.appId}] WS →`, JSON.stringify(msg).slice(0, 200));

        // session.create → assign from pool
        if (msg.method === 'session.create') {
            const clientId = msg.params?.clientId || null;

            // Check for pinned on-hold session (reconnecting client)
            if (clientId && this.clientPins.has(clientId)) {
                const pinnedSid = this.clientPins.get(clientId);
                const entry = this.pool.get(pinnedSid);
                if (entry && entry.state === 'on-hold') {
                    // Resume pinned session
                    clearTimeout(entry.holdTimer);
                    entry.holdTimer = null;
                    entry.state = 'active';
                    entry.ws = ws;
                    this.sessionToWs.set(pinnedSid, ws);
                    ws._poolSession = pinnedSid;
                    ws._clientId = clientId;
                    ws._appId = this.appId;
                    log('info', `[${this.appId}] Resumed pinned ${pinnedSid} for ${clientId}`);

                    ws.send(frame({
                        jsonrpc: '2.0', id: msg.id,
                        result: {
                            sessionId: pinnedSid,
                            resumed: true,
                            pendingQuestion: entry.holdInfo?.question,
                            pendingRequestId: entry.holdInfo?.requestId,
                        },
                    }));
                    return;
                }
                // Pin expired — clear stale
                this.clientPins.delete(clientId);
            }

            // Check for snapshot to restore (client-provided or server-cached)
            let snapshot = null;
            if (msg.params?.snapshot) {
                snapshot = Buffer.from(msg.params.snapshot, 'base64');
            } else if (clientId && this.clientSnapshots.has(clientId)) {
                snapshot = this.clientSnapshots.get(clientId).buffer;
            }

            // Assign from pool (lazy expand if empty)
            const clientTools = msg.params?.tools;
            let createdWithClientTools = false;
            if (this.available.length === 0) {
                const sid = `${this.appId}-pool-${this.pool.size}`;
                log('info', `[${this.appId}] Pool exhausted, lazy-creating ${sid}`);
                try {
                    await this.createPoolSession(sid, clientTools, msg.params?.systemMessage);
                    if (clientTools?.length > 0) createdWithClientTools = true;
                } catch (e) {
                    ws.send(frame({ jsonrpc: '2.0', id: msg.id,
                        error: { code: -1, message: `Failed to create session: ${e.message}` } }));
                    return;
                }
            }
            let sid = this.available.shift();
            let entry = this.pool.get(sid);
            entry.state = 'active';
            entry.ws = ws;
            entry.clientId = clientId;
            this.sessionToWs.set(sid, ws);
            ws._poolSession = sid;
            ws._clientId = clientId;
            ws._appId = this.appId;
            log('info', `[${this.appId}] Assigned ${sid}${clientId ? ` to ${clientId}` : ''}`);

            // If client provided custom tools and session wasn't already created with them, re-create
            if (clientTools?.length > 0 && !createdWithClientTools) {
                try {
                    const newSid = await this.recreatePoolSession(sid, clientTools, msg.params?.systemMessage);
                    // Update references to use the new session ID
                    sid = newSid;
                    entry = this.pool.get(newSid);
                    entry.state = 'active';
                    entry.ws = ws;
                    entry.clientId = clientId;
                    this.sessionToWs.set(newSid, ws);
                    ws._poolSession = newSid;
                } catch (e) {
                    log('error', `[${this.appId}] Failed to recreate ${sid} with client tools: ${e.message}`);
                    // Continue with existing session (will have only AGENT_TOOLS)
                }
            }

            // Restore snapshot if available
            if (snapshot && entry.workspacePath) {
                const ok = unzipToDirectory(snapshot, entry.workspacePath);
                log('info', `[${this.appId}] Snapshot restore: ${ok ? 'ok' : 'failed'}`);
            }

            // Extract conversation context from snapshot (client-sent or server-cached)
            let recoveredContext = null;
            if ((snapshot || (clientId && this.clientSnapshots.has(clientId))) && entry.workspacePath) {
                recoveredContext = extractConversationContext(entry.workspacePath);
                if (recoveredContext) {
                    log('info', `[${this.appId}] Extracted conversation context (${recoveredContext.length} chars)`);
                }
            }

            // Build response
            const result = { sessionId: sid };

            // Send server-side snapshot to client (for client-side persistence)
            if (clientId && this.clientSnapshots.has(clientId)) {
                const cached = this.clientSnapshots.get(clientId);
                result.snapshot = cached.buffer.toString('base64');
                result.snapshotTimestamp = cached.timestamp;
                this.clientSnapshots.delete(clientId);
            }

            // Include recovered context in response for client reference
            if (recoveredContext) {
                result.recoveredContext = recoveredContext;
            }

            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result }));

            // Auto-inject recovered context into the new session
            if (recoveredContext) {
                const contextId = this.nextId++;
                this.pendingRequests.set(contextId, {
                    ws: null, clientId: null, type: 'context-recovery',
                });
                this.cli.stdin.write(frame({
                    jsonrpc: '2.0', id: contextId,
                    method: 'session.send',
                    params: {
                        sessionId: sid,
                        prompt: recoveredContext + '\n\nThe above is your previous conversation with this user. Acknowledge the restored context briefly using send_response, then use ask_user to ask what the user wants to do next.',
                    },
                }));
                log('info', `[${this.appId}] Sent context recovery to ${sid}`);
            }

            return;
        }

        // session.resume → treat as create
        if (msg.method === 'session.resume') {
            msg.method = 'session.create';
            return this.handleClientMessage(ws, msg);
        }

        // session.disconnect / session.destroy
        if (msg.method === 'session.disconnect' || msg.method === 'session.destroy') {
            this.releaseSession(ws);
            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result: {} }));
            return;
        }

        // session.list → empty
        if (msg.method === 'session.list') {
            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result: [] }));
            return;
        }

        // Everything else: forward with remapped ID
        if (msg.id !== undefined) {
            const relayId = this.nextId++;
            this.pendingRequests.set(relayId, {
                ws, clientId: msg.id, type: 'forward',
            });
            msg.id = relayId;
        }
        this.cli.stdin.write(frame(msg));
    }

    releaseSession(ws) {
        const sid = ws._poolSession;
        if (!sid || !this.pool.has(sid)) return;
        const entry = this.pool.get(sid);
        const clientId = ws._clientId;

        // If on-hold (ask_user pending) and has clientId → start hold timer
        if (entry.state === 'on-hold' && clientId) {
            entry.ws = null;
            this.sessionToWs.delete(sid);
            ws._poolSession = null;
            ws._clientId = null;

            this.clientPins.set(clientId, sid);
            entry.holdTimer = setTimeout(() => {
                this.expireHeldSession(sid, clientId);
            }, HOLD_TIMEOUT);

            log('info', `[${this.appId}] Session ${sid} held for ${clientId} (${HOLD_TIMEOUT / 1000}s)`);
            return;
        }

        // Normal release → back to pool
        entry.state = 'available';
        entry.ws = null;
        entry.clientId = null;
        entry.holdInfo = null;
        this.sessionToWs.delete(sid);
        this.available.push(sid);
        ws._poolSession = null;
        ws._clientId = null;
        log('info', `[${this.appId}] Released ${sid} (available: ${this.available.length})`);
    }

    async expireHeldSession(sid, clientId) {
        const entry = this.pool.get(sid);
        if (!entry || entry.state !== 'on-hold') return;

        log('info', `[${this.appId}] Hold expired: ${sid} (client ${clientId})`);

        // Snapshot workspace before releasing
        if (entry.workspacePath) {
            const zipBuf = zipDirectory(entry.workspacePath);
            if (zipBuf) {
                this.clientSnapshots.set(clientId, {
                    buffer: zipBuf,
                    timestamp: Date.now(),
                });
                log('info', `[${this.appId}] Snapshot saved for ${clientId} (${(zipBuf.length / 1024).toFixed(1)}KB)`);
            }
        }

        // Auto-answer the pending ask_user
        if (entry.holdInfo?.requestId) {
            const relayId = this.nextId++;
            this.pendingRequests.set(relayId, {
                ws: null, clientId: null, type: 'hold-expire',
            });
            this.cli.stdin.write(frame({
                jsonrpc: '2.0', id: relayId,
                method: 'session.tools.handlePendingToolCall',
                params: {
                    sessionId: sid,
                    requestId: entry.holdInfo.requestId,
                    result: 'User disconnected. Session on hold expired.',
                },
            }));
        }

        // Release to pool (stale context ok)
        entry.state = 'available';
        entry.ws = null;
        entry.clientId = null;
        entry.holdInfo = null;
        entry.holdTimer = null;
        this.sessionToWs.delete(sid);
        this.clientPins.delete(clientId);
        this.available.push(sid);
        log('info', `[${this.appId}] ${sid} returned to pool (available: ${this.available.length})`);
    }

    stats() {
        const active = [...this.pool.values()].filter(s => s.state === 'active').length;
        const onHold = [...this.pool.values()].filter(s => s.state === 'on-hold').length;
        return {
            appId: this.appId,
            total: this.pool.size,
            available: this.available.length,
            active,
            onHold,
            pending: this.pendingRequests.size,
            pins: this.clientPins.size,
            snapshots: this.clientSnapshots.size,
        };
    }
}

// --- Workspace Manager ---
class WorkspaceManager {
    constructor() {
        this.workspaces = new Map(); // appId → PoolProxy
    }

    async start() {
        const config = this.loadConfig();

        for (const [appId, wsConfig] of Object.entries(config)) {
            const proxy = new PoolProxy({
                appId,
                cwd: wsConfig.path || os.homedir(),
                poolSize: wsConfig.poolSize || POOL_SIZE,
                model: wsConfig.model || MODEL,
                systemMessage: wsConfig.systemMessage || process.env.AGENT_INSTRUCTIONS || undefined,
                extraCliFlags: wsConfig.extraCliFlags || [],
            });
            await proxy.start();
            this.workspaces.set(appId, proxy);
        }

        if (this.workspaces.size === 0) {
            log('error', 'No workspaces configured');
            process.exit(1);
        }

        log('info', `Workspaces: ${[...this.workspaces.keys()].join(', ')}`);
    }

    loadConfig() {
        // Load from WORKSPACES env var
        if (WORKSPACES_CONFIG) {
            try {
                const raw = fs.readFileSync(WORKSPACES_CONFIG, 'utf-8');
                log('info', `Loaded workspace config from ${WORKSPACES_CONFIG}`);
                return JSON.parse(raw);
            } catch (e) {
                log('error', `Failed to load workspace config: ${e.message}`);
                process.exit(1);
            }
        }

        // Load from local workspaces.json
        const localConfig = path.join(__dirname, 'workspaces.json');
        if (fs.existsSync(localConfig)) {
            try {
                const raw = fs.readFileSync(localConfig, 'utf-8');
                log('info', `Loaded workspace config from ${localConfig}`);
                return JSON.parse(raw);
            } catch (e) {
                log('error', `Failed to load ${localConfig}: ${e.message}`);
            }
        }

        // Default: single workspace
        return {
            default: {
                path: os.homedir(),
                poolSize: POOL_SIZE,
                model: MODEL,
            },
        };
    }

    getProxy(appId) {
        if (appId && this.workspaces.has(appId)) {
            return this.workspaces.get(appId);
        }
        return this.workspaces.get('default') || this.workspaces.values().next().value;
    }

    async handleClientMessage(ws, msg) {
        // Handle ping before proxy assignment — clients send ping on connect
        if (msg.method === 'ping') {
            log('info', `Ping from client`);
            if (msg.id !== undefined) {
                ws.send(frame({ jsonrpc: '2.0', id: msg.id,
                    result: { message: 'pong', protocolVersion: 1 } }));
            }
            return;
        }

        let proxy;

        if (msg.method === 'session.create' || msg.method === 'session.resume') {
            const appId = msg.params?.appId || 'default';
            proxy = this.getProxy(appId);
            ws._proxy = proxy;
        } else {
            proxy = ws._proxy;
        }

        if (!proxy) {
            log('error', `No proxy for message from client`);
            if (msg.id !== undefined) {
                ws.send(frame({ jsonrpc: '2.0', id: msg.id,
                    error: { code: -1, message: 'No session — call session.create first' } }));
            }
            return;
        }

        await proxy.handleClientMessage(ws, msg);
    }

    releaseSession(ws) {
        if (ws._proxy) {
            ws._proxy.releaseSession(ws);
        }
    }

    allStats() {
        return [...this.workspaces.values()].map(p => p.stats());
    }
}

// --- Main ---
async function main() {
    const manager = new WorkspaceManager();
    await manager.start();

    const wss = new WebSocketServer({ port: PORT });
    const clientParsers = new Map();

    wss.on('connection', (ws, req) => {
        const addr = req.socket.remoteAddress;
        log('info', `Client connected from ${addr}`);
        const parser = new FrameParser();
        clientParsers.set(ws, parser);

        ws.on('message', (data) => {
            for (const msg of parser.feed(data)) {
                manager.handleClientMessage(ws, msg);
            }
        });

        ws.on('close', () => {
            manager.releaseSession(ws);
            clientParsers.delete(ws);
            log('info', `Client disconnected (${addr})`);
        });

        ws.on('error', (err) => {
            log('error', `WebSocket error: ${err.message}`);
            manager.releaseSession(ws);
        });
    });

    // Display info
    console.log(`\nCopilot Pool Relay v2`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Hold timeout: ${HOLD_TIMEOUT / 1000}s`);
    const stats = manager.allStats();
    for (const s of stats) {
        console.log(`  [${s.appId}] Pool: ${s.total} sessions`);
    }
    const interfaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) {
                console.log(`  → ws://${addr.address}:${PORT}`);
            }
        }
    }
    console.log(`\nReady.\n`);

    // Periodic stats (60s)
    setInterval(() => {
        for (const s of manager.allStats()) {
            log('info', `[${s.appId}] Stats: ${s.active} active, ${s.onHold} hold, ${s.available} avail, ${s.total} total, ${s.pins} pins, ${s.snapshots} snaps`);
        }
    }, 60000);

    // Cleanup old snapshots (>1 hour)
    setInterval(() => {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const proxy of manager.workspaces.values()) {
            for (const [cid, snap] of proxy.clientSnapshots) {
                if (snap.timestamp < cutoff) {
                    proxy.clientSnapshots.delete(cid);
                    log('info', `[${proxy.appId}] Cleaned stale snapshot: ${cid}`);
                }
            }
        }
    }, 5 * 60 * 1000);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
