#!/usr/bin/env node
/**
 * Copilot CLI Pool Relay Server
 * 
 * Raw proxy with session pooling. Pre-warms N sessions on startup,
 * lazily creates more on demand. Routes CLI responses to correct
 * WebSocket clients via RPC ID remapping and sessionId matching.
 * 
 * Architecture:
 *   iOS App → WebSocket → this relay → single CLI process (--headless --stdio)
 *                                       └─ N pooled sessions
 * 
 * Intercepted methods:
 *   session.create    → assign pool session (lazy expand if empty)
 *   session.resume    → treat as session.create
 *   session.disconnect/destroy → release session back to pool
 *   session.list      → return []
 *   Everything else   → forward to CLI with remapped RPC IDs
 * 
 * Usage:
 *   node relay-server.js
 *   PORT=8765 POOL_SIZE=3 node relay-server.js
 */

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.env.PORT) || 8765;
const CLI_PATH = process.env.CLI_PATH || findCopilotCLI();
const POOL_SIZE = parseInt(process.env.POOL_SIZE) || 3;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug' for verbose
const MODEL = process.env.MODEL || 'gpt-4.1';

// --- Agent Config ---
// System message and tools injected into every pool session.
// Matches iOS CopilotAgent.buildSessionConfig() / buildTools().
const AGENT_INSTRUCTIONS = process.env.AGENT_INSTRUCTIONS || 'You are a helpful AI assistant.';

function buildAgentSystemMessage(instructions) {
    return `${instructions}

IMPORTANT: You are an autonomous agent running in an infinite loop.
- Use the \`send_response\` tool to deliver your responses to the user. Do NOT just end your turn.
- Use the \`ask_user\` tool when you need more information or when all tasks are done to ask what to do next.
- Always use one of these tools before your turn ends.`;
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
    const candidates = [
        '/opt/homebrew/bin/copilot',
        '/usr/local/bin/copilot',
    ];
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
                // Bad frame — skip to next potential header
                this.buffer = this.buffer.slice(hdrEnd + 4);
                continue;
            }
            const bodyLen = parseInt(m[1]);
            const totalLen = hdrEnd + 4 + bodyLen;
            if (this.buffer.length < totalLen) break; // incomplete frame
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

// --- Pool Proxy ---
class PoolProxy {
    cli = null;
    parser = new FrameParser();
    pool = new Map();            // sessionId → { state: 'available'|'active'|'creating', ws: WebSocket|null }
    available = [];              // sessionIds ready to assign
    pendingRequests = new Map(); // relayId → { ws, clientId, type, sid?, resolve? }
    sessionToWs = new Map();     // sessionId → ws
    nextId = 100000;             // relay-internal RPC IDs (avoid collision with client IDs)

    async start() {
        log('info', `CLI: ${CLI_PATH}`);
        log('info', `Pool size: ${POOL_SIZE}`);

        // Spawn single CLI process
        this.cli = spawn(CLI_PATH, ['--headless', '--stdio', '--no-auto-update'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: os.homedir(),
        });
        log('info', `CLI started (PID: ${this.cli.pid})`);

        this.cli.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg) log('debug', `CLI stderr: ${msg}`);
        });

        this.cli.on('close', (code) => {
            log('error', `CLI exited with code ${code}`);
            process.exit(1);
        });

        // Route all CLI output through frame parser → router
        this.cli.stdout.on('data', (data) => {
            for (const msg of this.parser.feed(data)) {
                this.routeFromCli(msg);
            }
        });

        // Pre-warm pool sessions
        const createPromises = [];
        for (let i = 0; i < POOL_SIZE; i++) {
            createPromises.push(this.createPoolSession(`pool-${i}`));
        }
        await Promise.all(createPromises);
        log('info', `Pool ready: ${this.available.length} sessions`);
    }

    createPoolSession(sid) {
        return new Promise((resolve, reject) => {
            this.pool.set(sid, { state: 'creating', ws: null });
            const id = this.nextId++;
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Timeout creating session ${sid}`));
            }, 30000);

            this.pendingRequests.set(id, {
                ws: null, clientId: null, type: 'pool-create', sid,
                resolve: () => { clearTimeout(timeout); resolve(); },
            });

            this.cli.stdin.write(frame({
                jsonrpc: '2.0', id,
                method: 'session.create',
                params: {
                    sessionId: sid,
                    model: MODEL,
                    infiniteSessions: { enabled: true, backgroundCompactionThreshold: 0.80 },
                    requestPermission: true,
                    systemMessage: { mode: 'replace', content: buildAgentSystemMessage(AGENT_INSTRUCTIONS) },
                    tools: AGENT_TOOLS,
                },
            }));
        });
    }

    // --- CLI → Client routing ---
    routeFromCli(msg) {
        log('debug', `CLI →`, JSON.stringify(msg).slice(0, 200));

        // RPC response: match by tracked relay ID
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const req = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);

            if (req.type === 'pool-create') {
                this.pool.get(req.sid).state = 'available';
                this.available.push(req.sid);
                log('info', `Session ${req.sid} created`);
                req.resolve?.();
                return;
            }

            // Forward to client with original client-side ID
            if (req.ws?.readyState === 1) {
                msg.id = req.clientId;
                req.ws.send(frame(msg));
            }
            return;
        }

        // Notification or CLI-initiated request: route by sessionId
        const sid = msg.params?.sessionId;
        if (sid) {
            const ws = this.sessionToWs.get(sid);
            if (ws?.readyState === 1) {
                ws.send(frame(msg));
            } else {
                log('debug', `No client for session ${sid}, discarding`);
            }
            return;
        }

        log('debug', 'Unroutable CLI message:', JSON.stringify(msg).slice(0, 200));
    }

    // --- Client → CLI routing ---
    async handleClientMessage(ws, msg) {
        log('debug', `WS →`, JSON.stringify(msg).slice(0, 200));

        // session.create → assign from pool (lazy expand if empty)
        if (msg.method === 'session.create') {
            if (this.available.length === 0) {
                const sid = `pool-${this.pool.size}`;
                log('info', `Pool exhausted, lazy-creating ${sid}`);
                try {
                    await this.createPoolSession(sid);
                } catch (e) {
                    ws.send(frame({ jsonrpc: '2.0', id: msg.id,
                        error: { code: -1, message: `Failed to create session: ${e.message}` } }));
                    return;
                }
            }
            const sid = this.available.shift();
            this.pool.get(sid).state = 'active';
            this.pool.get(sid).ws = ws;
            this.sessionToWs.set(sid, ws);
            ws._poolSession = sid;
            log('info', `Assigned session ${sid} to client`);

            ws.send(frame({ jsonrpc: '2.0', id: msg.id,
                result: { sessionId: sid } }));
            return;
        }

        // session.resume → treat as create (pool sessions are interchangeable)
        if (msg.method === 'session.resume') {
            msg.method = 'session.create';
            return this.handleClientMessage(ws, msg);
        }

        // session.disconnect / session.destroy → release back to pool
        if (msg.method === 'session.disconnect' || msg.method === 'session.destroy') {
            this.releaseSession(ws);
            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result: {} }));
            return;
        }

        // session.list → return empty (pool is managed internally)
        if (msg.method === 'session.list') {
            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result: [] }));
            return;
        }

        // Everything else: forward to CLI with remapped ID
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

        this.pool.get(sid).state = 'available';
        this.pool.get(sid).ws = null;
        this.sessionToWs.delete(sid);
        this.available.push(sid);
        ws._poolSession = null;
        log('info', `Released session ${sid} (available: ${this.available.length})`);
    }

    stats() {
        const active = [...this.pool.values()].filter(s => s.state === 'active').length;
        return { total: this.pool.size, available: this.available.length, active, pending: this.pendingRequests.size };
    }
}

// --- Main ---
async function main() {
    const proxy = new PoolProxy();
    await proxy.start();

    const wss = new WebSocketServer({ port: PORT });
    const clientParsers = new Map();

    wss.on('connection', (ws, req) => {
        const addr = req.socket.remoteAddress;
        log('info', `Client connected from ${addr}`);
        const parser = new FrameParser();
        clientParsers.set(ws, parser);

        ws.on('message', (data) => {
            for (const msg of parser.feed(data)) {
                proxy.handleClientMessage(ws, msg);
            }
        });

        ws.on('close', () => {
            proxy.releaseSession(ws);
            clientParsers.delete(ws);
            log('info', `Client disconnected (${addr})`);
        });

        ws.on('error', (err) => {
            log('error', `WebSocket error: ${err.message}`);
            proxy.releaseSession(ws);
        });
    });

    // Show listen info
    console.log(`\nCopilot Pool Relay`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Pool: ${POOL_SIZE} sessions (lazy expansion enabled)`);
    const interfaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) {
                console.log(`  → ws://${addr.address}:${PORT}`);
            }
        }
    }
    console.log(`\nReady.\n`);

    // Periodic stats (every 60s)
    setInterval(() => {
        const s = proxy.stats();
        log('info', `Stats: ${s.active} active, ${s.available} available, ${s.total} total, ${s.pending} pending`);
    }, 60000);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
