# Relay Server + CLI Deployment Design

> **References**: [scaling.md](https://github.com/github/copilot-sdk/blob/main/docs/setup/scaling.md) · [backend-services.md](https://github.com/github/copilot-sdk/blob/main/docs/setup/backend-services.md) · [bundled-cli.md](https://github.com/github/copilot-sdk/blob/main/docs/setup/bundled-cli.md)

## Current Architecture

```
iOS App → WebSocket → relay-server.js → spawn copilot CLI → GitHub Copilot API
```

**Current flow:**
1. iOS app connects via WebSocket to relay-server.js on port 8765
2. Relay spawns a fresh `copilot --headless --stdio` process per connection
3. Raw Content-Length framed JSON-RPC flows bidirectionally
4. When client disconnects, CLI process is killed → all state lost

**Problems:**
- 1:1 connection:CLI mapping — each connection spawns a new CLI process
- No session persistence — reconnecting loses all context
- No authentication — anyone on the network can connect
- No session pooling — burst of connections = burst of CLI processes
- No recovery — network hiccup = lost session
- Single machine — relay + CLI must be colocated

---

## Key Insights from Official Copilot SDK Docs

### CLI as Headless Server (not per-connection spawn)
The SDK is designed for the CLI to run as a **persistent headless server** on a fixed port:
```bash
copilot --headless --port 4321
```
The `CopilotClient` from `@github/copilot-sdk` connects via TCP with `cliUrl`:
```javascript
import { CopilotClient } from "@github/copilot-sdk";
const client = new CopilotClient({ cliUrl: "localhost:4321" });
```
**This means our relay should use the SDK client, NOT raw stdio spawning.**

### Official Docker Image Exists
```bash
docker run -d --name copilot-cli \
    -p 4321:4321 \
    -e COPILOT_GITHUB_TOKEN="$TOKEN" \
    ghcr.io/github/copilot-cli:latest \
    --headless --port 4321
```
→ Answers Q1 about getting CLI in production. Use the official image.

### Built-in Session Management
```javascript
// Create named session
const session = await client.createSession({
    sessionId: `user-${userId}-chat`,
    model: "gpt-4.1",
});

// Resume existing session (useful for brief network drops)
const resumed = await client.resumeSession(sessionId);

// List all sessions
const sessions = await client.listSessions();

// Cleanup
await client.deleteSession(sessionId);
```
Session state lives at `~/.copilot/session-state/{sessionId}/` on the filesystem.

**However**: Since we use a shared Copilot account (service token) and camera agent sessions are ephemeral (per-filming-session), we don't need to persist session state across server restarts. Sessions are throwaway — `createSession()` every time is fine. The only value of `resumeSession()` is surviving brief network drops during an active filming session.

### 30-Minute Idle Timeout (Documented, Severity Low)
Per official SDK docs (`scaling.md` and `backend-services.md` Limitations tables): "Sessions without activity are auto-cleaned by the CLI." Not mentioned in `bundled-cli.md` — likely only affects headless server mode. VS Code never hits this because the extension generates constant traffic (completions, suggestions).

**For our relay**: Pool sessions receiving user traffic won't hit this. Only risk is relay running overnight with zero users. Mitigation options:
1. **Lazy pool** (recommended): Let idle sessions expire naturally, re-create on demand (~1-2s cold start)
2. **Keepalive**: Ping every 20 min (costs premium requests on idle, may be unnecessary)
3. **Ignore**: If relay always has some user traffic, this never fires

### Three Isolation Patterns

| Pattern | Isolation | Resources | Best For |
|---------|-----------|-----------|----------|
| **Isolated CLI Per User** | Complete | High (CLI per user) | Multi-tenant SaaS |
| **Shared CLI + Session Isolation** | Logical | Low (one CLI) | Internal tools |
| **Shared Sessions (Collaborative)** | Shared | Low | Team collab |

**Our pick: Pattern 2 (Shared CLI + Session Isolation)** — one CLI server, sessions isolated by naming: `{userId}-{purpose}-{timestamp}`.

### Vertical Scaling Pattern
```javascript
class SessionManager {
    private activeSessions = new Map();
    private maxConcurrent = 50;

    async getSession(sessionId) {
        if (this.activeSessions.has(sessionId)) return this.activeSessions.get(sessionId);
        if (this.activeSessions.size >= this.maxConcurrent) await this.evictOldest();
        const session = await client.createSession({ sessionId, model: "gpt-4.1" });
        this.activeSessions.set(sessionId, session);
        return session;
    }

    private async evictOldest() {
        const [oldestId] = this.activeSessions.keys();
        await this.activeSessions.get(oldestId).disconnect();
        this.activeSessions.delete(oldestId);
    }
}
```
Sessions are **safe to disconnect** — state is persisted automatically. `resumeSession()` brings them back.

### Health Checks
```javascript
const status = await client.getStatus();  // built-in
```

---

## Core Innovation: Session Rental Pool via Infinite Loop

### The Insight

Copilot charges by **premium request count** (each API call). Sessions running in infinite loop mode stay alive between users. Instead of creating/destroying sessions per user, we maintain a **pool of long-lived agent sessions** that users rent.

The key mechanism: when the agent finishes a task, it calls `ask_user("What next?")` — this **pauses the loop waiting for input**. The session becomes "available" in the pool. When a new user connects, their prompt is fed as the `ask_user` answer, and the agent continues the loop with the new user's task.

```
Session #1: [agent running] ── send_response ── ask_user ── [AVAILABLE] ── user input ── [agent running]
                                      ↑                          ↑                            ↑
                                 User A's result           User A done,             User B's prompt fed
                                 delivered via WS          session released          as ask_user answer
```

### Pool Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Session Rental Pool                    │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │Session #1│  │Session #2│  │Session #3│  ... (N)     │
│  │ ACTIVE   │  │AVAILABLE │  │AVAILABLE │             │
│  │ user-A   │  │ (idle at │  │ (idle at │             │
│  │ filming  │  │ ask_user)│  │ ask_user)│             │
│  └──────────┘  └──────────┘  └──────────┘             │
│       ↕              ↕              ↕                   │
│  ┌──────────────────────────────────────────────────┐  │
│  │         copilot --headless --port 4321           │  │
│  │         (one persistent CLI server)              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         ↑              ↑              ↑
    user-A WS      (waiting)      (waiting)
```

### How It Works

```javascript
import { CopilotClient } from "@github/copilot-sdk";

class SessionPool {
    client;
    sessions = new Map();     // sessionId → { agent, currentWs, resolveInput, state }
    available = [];           // Queue of sessions at ask_user (waiting for input)

    constructor(cliUrl) {
        this.client = new CopilotClient({ cliUrl });
    }

    async init(poolSize = 3) {
        for (let i = 0; i < poolSize; i++) {
            const sessionId = `pool-${i}`;
            const sessionState = {
                agent: null, currentWs: null, resolveInput: null, state: "starting"
            };
            this.sessions.set(sessionId, sessionState);

            const agent = await this.client.createAgent({
                model: "gpt-4.1",
                instructions: "You are a versatile AI assistant. Execute the user's request, " +
                    "then use send_response to deliver results. Then ask_user what to do next.",
                tools: [],  // User's tools injected dynamically per-session
                onResponse: (message) => {
                    // Route response to whichever user currently owns this session
                    if (sessionState.currentWs?.readyState === 1) {
                        sessionState.currentWs.send(JSON.stringify({
                            type: "response", message
                        }));
                    }
                },
                onAskUser: (question) => {
                    // Agent is done → release session to pool
                    return new Promise((resolve) => {
                        sessionState.resolveInput = resolve;
                        sessionState.state = "available";
                        this.available.push(sessionId);

                        // Notify current user that task is complete
                        if (sessionState.currentWs?.readyState === 1) {
                            sessionState.currentWs.send(JSON.stringify({
                                type: "ask", question,
                                hint: "session available for reuse"
                            }));
                        }
                    });
                }
            });

            sessionState.agent = agent;

            // Start the infinite loop — never stops
            agent.start("You are ready. Wait for user instructions via ask_user.")
                .catch(err => {
                    console.error(`Session ${sessionId} crashed:`, err);
                    sessionState.state = "crashed";
                });
        }
    }

    // Assign a user to an available session
    claimSession(ws, userPrompt) {
        if (this.available.length === 0) {
            ws.send(JSON.stringify({
                type: "error", message: "No sessions available. Try again shortly."
            }));
            return null;
        }

        const sessionId = this.available.shift();
        const session = this.sessions.get(sessionId);
        session.currentWs = ws;
        session.state = "active";

        // Feed user's prompt as the ask_user answer → agent continues loop
        if (session.resolveInput) {
            session.resolveInput(userPrompt);
            session.resolveInput = null;
        }

        return sessionId;
    }

    // Release session back to pool
    releaseSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.currentWs = null;
            // Session stays alive — agent will hit ask_user → back to pool
        }
    }

    // Keepalive: prevent 30-min idle timeout on available sessions
    startKeepalive(intervalMs = 20 * 60 * 1000) {  // every 20 min (well under 30 min limit)
        setInterval(() => {
            for (const sessionId of this.available) {
                const session = this.sessions.get(sessionId);
                if (session?.state === "available" && session.resolveInput) {
                    console.log(`[keepalive] Pinging session ${sessionId}`);
                    // Resolve ask_user with a no-op → agent processes, calls ask_user again
                    session.resolveInput(
                        "No user connected. Stay ready. Use ask_user to wait for the next task."
                    );
                    session.resolveInput = null;
                    session.state = "keepalive";
                    // Session will run one turn, call ask_user again → back to available
                }
            }
            // Remove keepalive sessions from available (they'll re-add themselves)
            this.available = this.available.filter(id => {
                const s = this.sessions.get(id);
                return s?.state === "available";
            });
        }, intervalMs);
    }

    // Auto-respawn crashed sessions
    startHealthCheck(intervalMs = 60 * 1000) {
        setInterval(async () => {
            for (const [sessionId, session] of this.sessions) {
                if (session.state === "crashed") {
                    console.log(`[health] Respawning crashed session ${sessionId}`);
                    await this.respawnSession(sessionId);
                }
            }
        }, intervalMs);
    }

    async respawnSession(sessionId) {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) return;

        sessionState.state = "starting";
        sessionState.resolveInput = null;
        sessionState.currentWs = null;

        const agent = await this.client.createAgent({
            model: "gpt-4.1",
            instructions: "You are a versatile AI assistant. Execute the user's request, " +
                "then use send_response to deliver results. Then ask_user what to do next.",
            tools: [],
            onResponse: (message) => {
                if (sessionState.currentWs?.readyState === 1) {
                    sessionState.currentWs.send(JSON.stringify({ type: "response", message }));
                }
            },
            onAskUser: (question) => {
                return new Promise((resolve) => {
                    sessionState.resolveInput = resolve;
                    sessionState.state = "available";
                    this.available.push(sessionId);
                    if (sessionState.currentWs?.readyState === 1) {
                        sessionState.currentWs.send(JSON.stringify({ type: "ask", question }));
                    }
                });
            }
        });

        sessionState.agent = agent;
        agent.start("You are ready. Wait for user instructions via ask_user.").catch(err => {
            console.error(`Session ${sessionId} crashed:`, err);
            sessionState.state = "crashed";
        });
    }
}
```

### WebSocket Relay (Complete)

```javascript
import { WebSocketServer } from "ws";

const pool = new SessionPool(process.env.CLI_URL || "localhost:4321");
await pool.init(parseInt(process.env.POOL_SIZE || "3"));
pool.startKeepalive();   // Prevent 30-min idle timeout
pool.startHealthCheck();  // Auto-respawn crashed sessions

const wss = new WebSocketServer({ port: process.env.PORT || 8765 });
const userSessions = new Map();  // ws → sessionId

wss.on("connection", (ws) => {
    ws.on("message", (data) => {
        const msg = JSON.parse(data);

        if (msg.type === "session_config") {
            // First message: claim a session from pool
            const sessionId = pool.claimSession(
                ws, msg.prompt || "What would you like me to do?"
            );
            if (sessionId) {
                userSessions.set(ws, sessionId);
                ws.send(JSON.stringify({ type: "session_ready", sessionId }));
            }
            return;
        }

        // Subsequent messages: feed as user input
        const sessionId = userSessions.get(ws);
        if (sessionId) {
            const session = pool.sessions.get(sessionId);
            if (session?.resolveInput) {
                session.resolveInput(msg.prompt || msg.message);
                session.resolveInput = null;
            } else {
                // Agent busy — steer it
                session.agent?.session.steer(msg.prompt || msg.message);
            }
        }
    });

    ws.on("close", () => {
        const sessionId = userSessions.get(ws);
        if (sessionId) {
            pool.releaseSession(sessionId);
            userSessions.delete(ws);
        }
    });
});

console.log(`Relay on :${process.env.PORT || 8765}, pool: ${process.env.POOL_SIZE || 3} sessions`);
```

### Session Lifecycle in Pool Mode

```
SERVER START
  → spawn CLI: copilot --headless --port 4321
  → create N agent sessions (infinite loop)
  → each session starts, runs initial prompt, hits ask_user → AVAILABLE
  → start keepalive timer (every 20 min)
  → start health check timer (every 1 min)

USER CONNECTS
  → WS connect + session_config message
  → pool.claimSession(ws, prompt)
  → available session's ask_user resolves with prompt
  → agent continues loop with user's task
  → agent calls tools, calls send_response → delivered via WS
  → agent calls ask_user → session becomes AVAILABLE again

USER SENDS MORE INPUT
  → if agent at ask_user: resolve with new prompt (seamless)
  → if agent busy: steer the current turn

USER DISCONNECTS
  → pool.releaseSession(sessionId)
  → session stays alive in loop
  → agent hits ask_user → back to AVAILABLE pool
  → next user gets this warm session

KEEPALIVE (every 20 min for idle sessions)
  → resolve ask_user with "stay ready, no user"
  → agent processes one no-op turn
  → agent calls ask_user again → back to AVAILABLE
  → prevents 30-minute CLI idle timeout

SESSION CRASH
  → detect via agent.start() rejection or health check
  → mark as "crashed", auto-respawn new agent
```

### Benefits of Pool Model

| Benefit | Explanation |
|---------|-------------|
| **Warm sessions** | No cold-start — agent already running |
| **Efficient resource use** | N sessions serve M users (M >> N) via time-sharing |
| **Premium request efficiency** | No session create/destroy overhead |
| **Natural flow control** | `ask_user` is a natural pause point |
| **Self-healing** | Crashed sessions auto-respawn |
| **Context accumulation** | Agent remembers tips from past interactions within session |

---

## Relay-to-CLI Communication: Two Options

### Key Constraint
The iOS app uses standard `createSession`/`resumeSession`/`session.send` JSON-RPC protocol (Content-Length framed). No new message types. The relay must speak this protocol.

### Option A: Raw Proxy with Session Multiplexing (Recommended)

The relay is a **transparent JSON-RPC proxy** between iOS and CLI. It forwards raw Content-Length framed messages, only intercepting `session.create`/`session.disconnect` to manage the pool.

```
iOS (WS, Content-Length framed JSON-RPC)
    ↓ raw bytes
Relay (parses just session.create / session.disconnect)
    ↓ raw bytes (sessionId rewritten)
CLI --headless --stdio  (or --port for TCP)
```

**How it works:**
1. Relay spawns CLI with `--headless --stdio` (current approach) or connects via TCP
2. At startup, relay sends N `session.create` requests to pre-warm pool sessions
3. Each pool session is configured with `infiniteSessions: { enabled: true }`
4. When iOS sends `session.create` → relay picks an available pool session, returns that session's ID
5. All subsequent messages from iOS are forwarded to CLI as-is (sessionId already matches)
6. CLI responses/events are forwarded back to iOS as-is
7. When iOS disconnects → relay marks session as available (does NOT send `session.disconnect` to CLI)
8. Next user's `session.create` → gets assigned the same warm session
9. Keepalive: relay periodically sends `session.send { prompt: "(keepalive)" }` to idle sessions

```javascript
// Raw proxy relay — just session.create interception
const net = require('net');

class PoolProxy {
    cli;            // CLI stdio process or TCP socket
    pool = [];      // pre-created session IDs
    available = []; // available session IDs
    assignments = new Map();  // ws → poolSessionId

    async init(poolSize = 3) {
        // Spawn CLI
        this.cli = spawn(CLI_PATH, ['--headless', '--stdio']);
        
        // Pre-warm pool
        for (let i = 0; i < poolSize; i++) {
            const sessionId = `pool-${i}`;
            const createReq = this.buildRPC("session.create", {
                sessionId,
                model: "gpt-4.1",
                infiniteSessions: { enabled: true },
                requestPermission: true,
            }, i + 1);
            this.cli.stdin.write(this.frame(createReq));
            this.pool.push(sessionId);
            this.available.push(sessionId);
        }
    }

    // Intercept session.create from iOS → assign pool session
    handleClientMessage(ws, rawData) {
        const parsed = this.parseFrame(rawData);
        if (!parsed) { this.forwardToCliRaw(rawData); return; }

        if (parsed.method === "session.create") {
            // Don't forward — assign existing pool session
            const poolId = this.available.shift();
            if (!poolId) {
                ws.send(this.frame(this.buildError(parsed.id, "No sessions available")));
                return;
            }
            this.assignments.set(ws, poolId);
            
            // Return pool session ID to iOS (synthesize response)
            ws.send(this.frame({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { sessionId: poolId }
            }));
            return;
        }

        if (parsed.method === "session.disconnect" || parsed.method === "session.destroy") {
            // Don't forward — just release session back to pool
            const poolId = this.assignments.get(ws);
            if (poolId) {
                this.available.push(poolId);
                this.assignments.delete(ws);
            }
            ws.send(this.frame({ jsonrpc: "2.0", id: parsed.id, result: {} }));
            return;
        }

        // Everything else: forward as-is (sessionId already correct from assignment)
        this.forwardToCliRaw(rawData);
    }

    // Keepalive: ping idle pool sessions every 20 min
    startKeepalive() {
        setInterval(() => {
            for (const sessionId of this.available) {
                const keepalive = this.buildRPC("session.send", {
                    sessionId,
                    prompt: "(system keepalive — session pool heartbeat)",
                    mode: "enqueue",
                }, Date.now());
                this.cli.stdin.write(this.frame(keepalive));
            }
        }, 20 * 60 * 1000);
    }

    frame(obj) {
        const json = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
    }
    
    parseFrame(data) {
        // Extract JSON from Content-Length framed message
        const str = data.toString();
        const idx = str.indexOf('\r\n\r\n');
        if (idx < 0) return null;
        return JSON.parse(str.slice(idx + 4));
    }
}
```

**Advantages:**
- iOS app **unchanged** — uses standard CopilotSDK protocol
- Relay is ~100 lines (parse frames, intercept create/disconnect, forward rest)
- Full protocol compatibility (tools, hooks, permissions all work)
- Session sharing: same CLI session serves multiple users sequentially

**The agent loop runs on the iOS device** (CameraKitAgentViewModel). The relay just proxies. Tools execute on-device.

### Option B: SDK API Translation

The relay uses `@github/copilot-sdk` CopilotClient to manage sessions programmatically, and translates between iOS JSON-RPC and SDK API calls.

```
iOS (WS, JSON-RPC) → Relay (parse → SDK API calls) → CopilotClient → CLI (TCP)
```

- `session.create` → `client.createSession(config)`
- `session.send` → `session.send(prompt)` or resolve `ask_user`
- `session.event` ← synthesized from session event subscriptions

**Advantages:** Cleaner abstraction, can use SDK features (agent loop server-side).
**Disadvantages:** Must translate every JSON-RPC method to SDK call. More code. Tools need server-side handling or forwarding.

### Recommendation: Option A (Raw Proxy)

Raw proxy is simpler and keeps the iOS app unchanged. The agent loop + tools run on the iOS device where the camera hardware is. The relay just manages the session pool and forwards bytes.

---

## Detailed Raw Proxy Design

### Message Multiplexing

One CLI process handles all pool sessions. CLI output (stdout) interleaves messages from multiple sessions. The relay routes each message to the correct WebSocket client.

**CLI → Client routing** (by `sessionId` in JSON):
```
CLI stdout: Content-Length: 123\r\n\r\n{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"pool-2","event":{...}}}
           ↓ parse sessionId = "pool-2"
           ↓ lookup: pool-2 → ws client #7
           ↓ forward to ws #7
```

All CLI notifications include `sessionId` in params:
- `session.event` → `params.sessionId`
- `permission.request` → `params.sessionId`
- `userInput.request` → `params.sessionId`
- `hooks.invoke` → `params.sessionId`

**Client → CLI routing** (no rewriting needed):
When a client sends `session.send { sessionId: "pool-2", prompt: "..." }`, the sessionId already matches the pool session (assigned at create time). Forward as-is.

### Content-Length Frame Parser

The CLI uses Content-Length framing (same as LSP). The relay must buffer and parse:

```javascript
class FrameParser {
    buffer = Buffer.alloc(0);
    
    feed(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        const messages = [];
        
        while (true) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) break;
            
            const header = this.buffer.slice(0, headerEnd).toString();
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) break;
            
            const bodyLen = parseInt(match[1]);
            const totalLen = headerEnd + 4 + bodyLen;
            if (this.buffer.length < totalLen) break;  // incomplete
            
            const body = this.buffer.slice(headerEnd + 4, totalLen);
            messages.push(JSON.parse(body.toString()));
            this.buffer = this.buffer.slice(totalLen);
        }
        
        return messages;
    }
}
```

### Request/Response Matching

For JSON-RPC requests (which have `id`), the CLI responds with matching `id`. The relay:
1. When client sends a request with `id: 42`, records: `{id: 42, ws: client#7}`
2. When CLI responds with `id: 42`, routes to client#7 based on the recorded mapping
3. Cleans up the mapping after delivery

For notifications (no `id`), route by `sessionId` field.

```javascript
class MessageRouter {
    sessionToWs = new Map();    // poolSessionId → ws
    pendingRequests = new Map(); // rpcId → ws (for request/response pairing)
    rpcIdCounter = 1;
    clientIdMap = new Map();     // clientRpcId → relayRpcId (for ID collision avoidance)

    // Route CLI → client
    routeFromCli(message) {
        // Response: match by id
        if (message.id !== undefined && message.result !== undefined) {
            const ws = this.pendingRequests.get(message.id);
            if (ws) {
                this.pendingRequests.delete(message.id);
                return ws;
            }
        }
        
        // Notification: match by sessionId
        if (message.params?.sessionId) {
            return this.sessionToWs.get(message.params.sessionId);
        }
        
        // RPC request from CLI (permission.request, etc): match by sessionId
        if (message.method && message.params?.sessionId) {
            return this.sessionToWs.get(message.params.sessionId);
        }
        
        return null;  // unroutable (keepalive responses, etc)
    }
    
    // Track client → CLI requests
    trackRequest(ws, rpcId) {
        this.pendingRequests.set(rpcId, ws);
    }
}
```

### RPC ID Collision

Multiple clients may use the same `id` values (both start from 1). The relay needs to remap IDs:

```javascript
// Client #1 sends: { id: 1, method: "session.send", ... }
// Client #2 sends: { id: 1, method: "session.send", ... }
// → Both have id:1! Relay must remap:
// → Forward to CLI as id: 1001 and id: 1002
// → When CLI responds with id: 1001, remap back to id: 1 and route to client #1
```

### Session States

```
┌─────────┐    assign    ┌────────┐    client disc.   ┌───────────┐
│AVAILABLE │──────────────│ ACTIVE │──────────────────│ RELEASING │
│(in pool) │              │(has ws)│                   │(no ws,    │
└──────┬──┘              └───┬────┘                   │ in flight)│
       │                     │                         └─────┬─────┘
       │                     │ turn ends                      │ all in-flight done
       │                     ▼                                │
       │  ◄────────────── idle timeout                        │
       └──────────────────────────────────────────────────────┘
```

Pool session states:
- **available**: In pool, no user assigned, ready to claim
- **active**: User's WS connected, forwarding messages
- **releasing**: User disconnected, but some in-flight requests may still be pending
- **keepalive**: Currently processing keepalive ping

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Client sends `session.create` but pool empty | Return error: `{ "error": { "code": -1, "message": "No sessions available" } }` |
| Client sends `session.resume` | Treat same as `session.create` — assign available pool session |
| Client sends `session.disconnect` | Don't forward to CLI. Release session back to pool. |
| Client sends `session.destroy` | Don't forward. Release session. |
| Client sends `session.list` | Return `[]` (sessions are managed by relay) |
| Keepalive response from CLI | Discard (no WS client to route to) |
| CLI process crashes | Restart CLI, re-create pool sessions, disconnect all clients |
| WS client disconnects abruptly | Release their session, discard in-flight responses |
| Client sends to session before assignment | Return error |
| Same `id` from multiple clients | Remap IDs to avoid collision |

### Keepalive Strategy

For idle pool sessions, the 30-min timeout (per SDK docs) may expire them. Two strategies:

**Strategy A: Lazy Pool (Recommended)**
Let idle sessions expire naturally. Re-create on demand when a user arrives and no sessions are available:
```javascript
// In handleClientMessage, when pool is empty:
if (this.available.length === 0) {
    // Create a fresh session on-the-fly (~1-2s)
    const sid = `pool-${this.pool.size}`;
    await this.createPoolSession(sid);
    // Then assign to user
}
```
- No idle cost
- First user after long idle pays ~1-2s cold start
- Simpler code

**Strategy B: Keepalive**
Periodically ping idle sessions to prevent expiry:
```javascript
// Every 20 minutes, for each available session:
session.send({
    sessionId: poolId,
    prompt: "ping",    // Costs 1 premium request per ping
    mode: "enqueue"
})
```
- Sessions always warm
- Costs premium requests even when nobody is using the relay <-- **not recommended**

The complete relay server below uses Strategy A (lazy pool):

### Complete Relay Server (Option A)

```javascript
#!/usr/bin/env node
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT) || 8765;
const CLI_PATH = process.env.CLI_PATH || '/opt/homebrew/bin/copilot';
const POOL_SIZE = parseInt(process.env.POOL_SIZE) || 3;

// --- Frame Parser ---
class FrameParser {
    buffer = Buffer.alloc(0);
    feed(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        const messages = [];
        while (true) {
            const hdr = this.buffer.indexOf('\r\n\r\n');
            if (hdr < 0) break;
            const m = this.buffer.slice(0, hdr).toString().match(/Content-Length:\s*(\d+)/i);
            if (!m) break;
            const len = parseInt(m[1]);
            if (this.buffer.length < hdr + 4 + len) break;
            messages.push(JSON.parse(this.buffer.slice(hdr + 4, hdr + 4 + len).toString()));
            this.buffer = this.buffer.slice(hdr + 4 + len);
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
    cli;
    parser = new FrameParser();
    pool = new Map();           // sessionId → { state, ws }
    available = [];
    pendingRequests = new Map(); // relayId → { ws, clientId }
    sessionToWs = new Map();     // sessionId → ws
    nextId = 100000;

    async start() {
        // Spawn CLI
        this.cli = spawn(CLI_PATH, ['--headless', '--stdio', '--no-auto-update'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.cli.stderr.on('data', d => process.stderr.write(`[CLI] ${d}`));
        this.cli.on('close', code => { console.error(`CLI exited: ${code}`); process.exit(1); });

        // Route CLI → clients
        this.cli.stdout.on('data', (data) => {
            for (const msg of this.parser.feed(data)) {
                this.routeFromCli(msg);
            }
        });

        // Pre-warm pool
        for (let i = 0; i < POOL_SIZE; i++) {
            await this.createPoolSession(`pool-${i}`);
        }

        console.log(`Pool ready: ${POOL_SIZE} sessions`);
    }

    createPoolSession(sid) {
        return new Promise((resolve) => {
            this.pool.set(sid, { state: 'creating', ws: null });
            const id = this.nextId++;
            this.pendingRequests.set(id, { ws: null, clientId: null, type: 'pool-create', sid, resolve });
            this.cli.stdin.write(frame({
                jsonrpc: '2.0', id,
                method: 'session.create',
                params: {
                    sessionId: sid,
                    model: 'gpt-4.1',
                    infiniteSessions: { enabled: true },
                    requestPermission: true,
                },
            }));
        });
    }

    routeFromCli(msg) {
        // Response to a tracked request
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const req = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);
            
            if (req.type === 'pool-create') {
                // Pool session created
                this.pool.get(req.sid).state = 'available';
                this.available.push(req.sid);
                req.resolve?.();
                return;
            }
            
            // Forward to client with original ID
            if (req.ws?.readyState === 1) {
                msg.id = req.clientId;
                req.ws.send(frame(msg));
            }
            return;
        }

        // Notification/request: route by sessionId
        const sid = msg.params?.sessionId;
        if (sid) {
            const ws = this.sessionToWs.get(sid);
            if (ws?.readyState === 1) {
                ws.send(frame(msg));
            }
            // else: discard (keepalive or disconnected client)
        }
    }

    async handleClientMessage(ws, msg) {
        // Intercept session.create → assign pool session (lazy pool: create on demand)
        if (msg.method === 'session.create') {
            if (this.available.length === 0) {
                // Lazy pool: create a new session on-the-fly
                const sid = `pool-${this.pool.size}`;
                await this.createPoolSession(sid);
            }
            const sid = this.available.shift();
            this.pool.get(sid).state = 'active';
            this.pool.get(sid).ws = ws;
            this.sessionToWs.set(sid, ws);
            ws._poolSession = sid;

            // Return pool session ID
            ws.send(frame({ jsonrpc: '2.0', id: msg.id,
                result: { sessionId: sid } }));
            return;
        }

        // Intercept session.disconnect / session.destroy → release
        if (msg.method === 'session.disconnect' || msg.method === 'session.destroy') {
            this.releaseSession(ws);
            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result: {} }));
            return;
        }

        // Intercept session.resume → treat as create
        if (msg.method === 'session.resume') {
            msg.method = 'session.create';
            return this.handleClientMessage(ws, msg);
        }

        // Intercept session.list → return empty
        if (msg.method === 'session.list') {
            ws.send(frame({ jsonrpc: '2.0', id: msg.id, result: [] }));
            return;
        }

        // Everything else: forward to CLI (remap ID)
        if (msg.id !== undefined) {
            const relayId = this.nextId++;
            this.pendingRequests.set(relayId, { ws, clientId: msg.id, type: 'forward' });
            msg.id = relayId;
        }
        this.cli.stdin.write(frame(msg));
    }

    releaseSession(ws) {
        const sid = ws._poolSession;
        if (sid && this.pool.has(sid)) {
            this.pool.get(sid).state = 'available';
            this.pool.get(sid).ws = null;
            this.sessionToWs.delete(sid);
            this.available.push(sid);
            ws._poolSession = null;
        }
    }

}

// --- WebSocket Server ---
const proxy = new PoolProxy();
proxy.start().then(() => {
    const wss = new WebSocketServer({ port: PORT });
    const clientParser = new Map();

    wss.on('connection', (ws) => {
        const parser = new FrameParser();
        clientParser.set(ws, parser);

        ws.on('message', (data) => {
            for (const msg of parser.feed(data)) {
                proxy.handleClientMessage(ws, msg);
            }
        });

        ws.on('close', () => {
            proxy.releaseSession(ws);
            clientParser.delete(ws);
        });
    });

    console.log(`Relay on :${PORT}, pool: ${POOL_SIZE} sessions (lazy expansion enabled)`);
});
```

---

## Design Principle: Client-Owned Session Config

**The iOS app owns all session configuration. The relay server is stateless.**

This means:
- The app stores: model, skill, tools, systemMessage, sessionId, preferences
- On connect, the app sends its full config to the relay
- The relay creates/resumes sessions using client-provided config
- No SQLite/Redis on server — dramatically simpler deployment

### Why Client-Owned?

| | Server-Owned Config | Client-Owned Config |
|---|---|---|
| Server complexity | SQLite + config store + recovery | Stateless — just forward |
| Multi-device | Config lives in one place | Config per device (or sync via iCloud) |
| New client | Needs API to set config | Just send config on connect |
| Server failure | Must restore configs | Nothing to restore — client resends |
| Privacy | Server knows user's tools/model | Server is a dumb pipe |

---

## Revised Architecture

### Architecture (Client-Owned Config)

```
┌─────────────────────────────┐
│  iOS App                    │
│                             │
│  SessionConfigStore         │
│  ├── model: "gpt-4.1"      │         ┌──────────────────────┐
│  ├── skill: filmDirector    │  WS     │  Stateless Relay     │
│  ├── tools: [...]           │────────>│                      │
│  ├── sessionId: "abc-cam"   │         │  1. Parse config     │   TCP    ┌──────────────┐
│  ├── systemMsg: "..."       │         │  2. Resume/Create    │─────────>│ copilot CLI  │
│  └── onDevice: false        │         │  3. Bridge messages  │          │ --headless   │
│                             │<────────│                      │<─────────│ --port 4321  │
│  On connect: sends config   │  WS     │  No storage needed   │   TCP    │              │
└─────────────────────────────┘         └──────────────────────┘          └──────────────┘
                                                                          ~/.copilot/
                                                                            session-state/
```

### Connection Protocol

**Step 1: App connects with config**
```json
// First WS message from iOS app
{
    "type": "session_config",
    "userId": "device-00008150-000449D93620401C",
    "sessionId": "device-00008150-camera",
    "config": {
        "model": "gpt-4.1",
        "systemMessage": "You are a cinema-grade film director...",
        "tools": [...],
        "infiniteSessions": { "enabled": true, "backgroundCompactionThreshold": 0.80 },
        "reasoningEffort": "medium"
    }
}
```

**Step 2: Relay creates/resumes session**
```javascript
// Relay receives config, creates session
const { userId, sessionId, config } = firstMessage;

let session;
try {
    session = await client.resumeSession(sessionId);
} catch {
    session = await client.createSession({ sessionId, ...config });
}

// Send ready acknowledgment
ws.send(JSON.stringify({ type: "session_ready", sessionId }));
```

**Step 3: Normal message flow**
```json
// All subsequent messages are raw JSON-RPC, forwarded as-is
{"jsonrpc": "2.0", "method": "sendMessage", "params": {...}, "id": 1}
```

### iOS App: SessionConfigStore

```swift
/// Persists session configuration locally on device
class SessionConfigStore: ObservableObject {
    static let shared = SessionConfigStore()
    
    @AppStorage("session.model") var model = "gpt-4.1"
    @AppStorage("session.skill") var skillName = "filmDirector"
    @AppStorage("session.sessionId") var sessionId = ""
    @AppStorage("session.onDevice") var useOnDevice = false
    @AppStorage("session.relayHost") var relayHost = "10.0.0.111"
    @AppStorage("session.relayPort") var relayPort = "8765"
    @AppStorage("session.reasoning") var reasoningEffort = "medium"
    
    var skill: CameraSkill { CameraSkill(rawValue: skillName) ?? .filmDirector }
    
    /// Generate stable session ID from device identity
    func ensureSessionId() -> String {
        if sessionId.isEmpty {
            let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
            sessionId = "\(deviceId)-camera"
        }
        return sessionId
    }
    
    /// Build config JSON to send on WebSocket connect
    func connectionConfig() -> [String: Any] {
        return [
            "type": "session_config",
            "userId": UIDevice.current.identifierForVendor?.uuidString ?? "unknown",
            "sessionId": ensureSessionId(),
            "config": [
                "model": model,
                "systemMessage": skill.systemPrompt,
                "infiniteSessions": ["enabled": true, "backgroundCompactionThreshold": 0.80],
                "reasoningEffort": reasoningEffort,
            ]
        ]
    }
}
```

### Relay Server (Simplified)

```javascript
import { CopilotClient } from "@github/copilot-sdk";
import { WebSocketServer } from "ws";

const client = new CopilotClient({ cliUrl: process.env.CLI_URL || "localhost:4321" });
const wss = new WebSocketServer({ port: process.env.PORT || 8765 });
const sessions = new Map(); // ws → session (in-memory only, no persistence needed)

wss.on("connection", (ws) => {
    let session = null;
    let configured = false;

    ws.on("message", async (data) => {
        const msg = JSON.parse(data);

        // First message must be session_config
        if (!configured && msg.type === "session_config") {
            const { sessionId, config } = msg;
            try {
                session = await client.resumeSession(sessionId);
            } catch {
                session = await client.createSession({ sessionId, ...config });
            }
            sessions.set(ws, session);
            configured = true;
            ws.send(JSON.stringify({ type: "session_ready", sessionId }));
            return;
        }

        // All subsequent messages: forward to session
        if (session) {
            const response = await session.sendAndWait({ prompt: msg.params?.prompt });
            ws.send(JSON.stringify(response));
        }
    });

    ws.on("close", () => {
        if (session) {
            session.disconnect(); // state persisted by CLI
            sessions.delete(ws);
        }
    });
});
```

**That's the entire relay server.** ~40 lines. No SQLite, no Redis, no config store.

### Core Concepts

#### 1. Session Identity
```
session_id: "{deviceVendorId}-{purpose}"  // stable across app restarts
user_id:    UIDevice.identifierForVendor  // unique per device+app
```

The app generates a stable session ID from the device's vendor identifier. Same device always gets the same session.

#### 2. Session Lifecycle

```
app launch → load SessionConfigStore from UserDefaults
  → connect WebSocket to relay
  → send session_config (first message)
  → relay: resumeSession(sessionId) or createSession(config)
  → relay: send "session_ready"
  → normal message flow

disconnect (app background, network drop)
  → relay: session.disconnect() → state persisted on CLI disk

reconnect
  → app sends same session_config
  → relay: resumeSession(sessionId) → instant resume with full history

new session (user taps "New Chat")
  → app generates new sessionId
  → app sends session_config with new ID
  → relay: createSession(newConfig)

settings change (user changes model, skill, etc.)
  → update SessionConfigStore (persists to UserDefaults)
  → disconnect + reconnect with new config
  → or: send "update_config" message to relay
```

#### 3. Config Versioning

The app can include a config version to handle protocol evolution:
```json
{
    "type": "session_config",
    "version": 1,
    "userId": "...",
    "sessionId": "...",
    "config": { ... }
}
```

#### 4. User Authentication

**Clarified by SDK docs — 3 levels:**

| Method | How | Best For |
|--------|-----|----------|
| **Service Token** | Single `COPILOT_GITHUB_TOKEN` on CLI server | Internal/single-org use |
| **Per-User OAuth** | Pass `githubToken` per CopilotClient instance | Multi-tenant SaaS |
| **BYOK** | Your own OpenAI/Anthropic key, no GitHub auth | Self-hosted |

**Plan:**
- Phase 1: Service token (our GitHub account)  
- Phase 2: Per-user GitHub OAuth (users bring their own Copilot subscription)
- Phase 3: BYOK option for power users (client sends API key in config)

---

## Implementation Plan (Revised — Pool + Client-Owned Config)

### Phase 1: Pool Relay Server (~3 hours)
Server side:
- `npm install @github/copilot-sdk ws`
- Implement `SessionPool` class: init N agents in infinite loop, claim/release
- Implement WebSocket relay: session_config → claimSession → bridge
- Start CLI headless: `copilot --headless --port 4321`
- Test locally with wscat

### Phase 2: iOS Session Config Protocol (~2 hours)
Client side:
- Create `SessionConfigStore.swift` with `@AppStorage` properties
- Modify `CameraKitAgentViewModel` to send `session_config` as first WS message
- Handle `session_ready`, `response`, `ask` message types from relay
- Add settings UI for model picker, reasoning effort
- Test: connect → task → response → ask → new task flow

### Phase 3: Docker Deployment (~1 hour)
```yaml
version: "3.8"
services:
  copilot-cli:
    image: ghcr.io/github/copilot-cli:latest
    command: ["--headless", "--port", "4321"]
    environment:
      - COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN}
    ports:
      - "4321:4321"
    restart: always
    # No persistent volume needed — sessions are ephemeral (shared account)

  relay:
    build: ./relay
    environment:
      - CLI_URL=copilot-cli:4321
      - PORT=8765
    depends_on:
      - copilot-cli
    ports:
      - "8765:8765"
```

Deploy to: **Fly.io** (free tier), **Railway**, or VPS with Docker Compose.

### Phase 4: Horizontal Scaling (Future)
When >50 concurrent users:
- Multiple CLI servers behind load balancer
- Shared storage (NFS/EFS) for `~/.copilot/session-state/`
- Sticky sessions (hash userId → server) or shared filesystem
- K8s deployment with PersistentVolumeClaim

### Phase 5: Per-User Auth (Future)
- GitHub OAuth flow: user signs in, we get their token
- Pass per-user token: `CopilotClient({ cliUrl, githubToken: user.token })`
- Each user uses their own Copilot subscription/quota

---

## File Structure (Revised)

```
relay/
├── server.js              # WebSocket server — parse config, bridge to SDK (~40 lines)
├── config.js              # PORT, CLI_URL, MAX_SESSIONS env vars
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

No `session-manager.js`, no `auth.js`, no `config-store.js` — client sends everything.

iOS additions:
```
Intento/
├── Services/
│   └── SessionConfigStore.swift   # @AppStorage-based config persistence
└── Views/
    └── Settings/
        └── SessionSettingsView.swift  # Model picker, reasoning, etc.
```

---

## Key Design Answers (Updated)

### 1. How to get Copilot CLI in production?
**ANSWERED**: Use official Docker image `ghcr.io/github/copilot-cli:latest`. Or install via `npm install @github/copilot`. Platform-specific binaries available: `copilot-darwin-arm64`, `copilot-linux-x64`, etc.

### 2. State recovery fidelity
**MOSTLY SOLVED**: SDK's `resumeSession()` handles full conversation recovery from disk. `infiniteSessions` with `backgroundCompactionThreshold: 0.80` auto-compacts when context gets large. We only need to save custom tool registrations and user preferences separately.

### 3. CLI process limits
**REVISED**: With shared CLI pattern, one CLI handles up to ~50 concurrent sessions. Memory is dominated by session state, not process count. Scale by adding CLI replicas behind a load balancer.

### 4. Authentication
**CLARIFIED**: Start with service token (`COPILOT_GITHUB_TOKEN`). Upgrade to per-user OAuth when needed. BYOK option for users who want to use their own API keys.

---

## Production Checklist (from SDK docs)

| Item | Action |
|------|--------|
| Session cleanup | CLI auto-cleans after 30 min idle. Optionally run periodic `deleteSession()` |
| Health checks | `client.getStatus()` — restart CLI if unresponsive |
| Storage | Not needed — shared account, ephemeral sessions |
| Secrets | Docker secrets or env vars for `COPILOT_GITHUB_TOKEN` |
| Monitoring | Track active session count, response latency, error rates |

## Known Limitations

| Limitation | Mitigation |
|------------|------------|
| No built-in session locking | App-level Redis lock (only if collaborative) |
| No built-in load balancing | External LB or service mesh |
| Session state is file-based | Shared filesystem (NFS/EFS) for multi-server |
| 30-minute idle timeout | Periodic keepalive or accept re-creation |
| CLI is single-process | Scale by adding more CLI server instances |

---

## Recommendation

**Client-owned config + SDK relay = minimal server:**

1. `npm install @github/copilot-sdk ws`
2. Start CLI headless: `copilot --headless --port 4321`  
3. 40-line relay: parse `session_config` → `resumeSession()` / `createSession()` → bridge
4. iOS app: `SessionConfigStore` with `@AppStorage` → sends config on connect
5. Docker Compose: two services (CLI + relay), one persistent volume

This gives:
- Session recovery (SDK `resumeSession()` from disk)
- Fast reconnect (client resends config, server resumes)
- Context compaction (`infiniteSessions`)
- Multi-user (shared CLI, isolated sessions)  
- Stateless server (no DB, no config store, no persistent volume)
- Client owns all config (privacy, simplicity)
- ~3-4 hours total implementation

### Even Simpler Alternative

Since sessions are ephemeral with a shared account, we could skip the SDK entirely and keep the current `copilot --headless --stdio` approach — just add the `session_config` protocol on top:

```
iOS sends session_config → relay spawns CLI with config → bridge → done
```

The SDK gives us `resumeSession()` for network resilience mid-filming, but if that's not critical, the current spawn-per-connection model works fine with just the config protocol added.
