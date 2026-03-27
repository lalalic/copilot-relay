# Copilot Relay v2 — Session Lifecycle, Context Recovery, Multi-Workspace

## Status: IMPLEMENTED & TESTED ✓ (12/12 tests passed)

### Architecture

```
                                 ┌─── CLI-1 (cwd: /apps/intento)  → pool: N sessions
iOS App ─→ WebSocket ─→ Relay ──┼─── CLI-2 (cwd: /apps/bullx)    → pool: N sessions
                                 └─── (default)                    → pool: N sessions
                        │
                  WorkspaceManager
                  routes by appId
```

### Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Hold expiry action | Keep session for pool (stale context ok) | No session destroy overhead, next user gets warm context |
| Context recovery | Zip workspace to client (tar.gz snapshot) | Client-owned state, survives server restart |
| Multi-workspace | One CLI per workspace, shared pool | Each app has its own agent config, skills, files |
| Session scope | Shared pool per app | Sessions interchangeable among users within an app |
| Deployment | Multi-workspace in single relay process | Simpler than K8s per-app pods |
| Default workspace | Yes, `cwd: ~` when no `workspaces.json` | Works out of the box |

---

## 1. Session Hold (ask_user → on-hold)

### Problem
When the agent calls `ask_user`, the session waits for user input. If the user disconnects (app backgrounded, network loss), the session is stuck.

### Session States

```
creating → available → active → on-hold → [client reconnects] → active
                ↑         │         │
                │         │         └─ [timeout expires] → snapshot + auto-answer → available
                │         └─ [normal disconnect] → available
                └─────────────────────────────────────────── (back to pool)
```

### Flow

**Happy path (client answers):**
1. Agent calls `ask_user` → CLI emits `external_tool.requested` event
2. Relay intercepts → marks session `on-hold`, records `requestId` + question
3. Client sees question → sends `session.tools.handlePendingToolCall`
4. Relay detects `external_tool.completed` → session returns to `active`

**Client disconnects while on-hold:**
1. `releaseSession()` detects `state === 'on-hold'` AND `clientId` present
2. Does NOT release to pool — starts hold timer instead
3. Pins session: `clientPins.set(clientId, sessionId)`
4. Session stays on-hold, waiting for reconnect or timeout

**Client reconnects within timeout:**
1. Client sends `session.create` with same `clientId`
2. Relay finds pinned session → clears hold timer
3. Returns `{ sessionId, resumed: true, pendingQuestion: {...} }`
4. Client can answer the pending `ask_user`

**Hold timeout expires (default: 10 minutes):**
1. Relay snapshots workspace directory → `tar.gz` (~10KB)
2. Stores snapshot: `clientSnapshots.set(clientId, { buffer, timestamp })`
3. Auto-answers pending `ask_user`: "User disconnected. Session on hold expired."
4. Releases session back to pool with stale context (NOT destroyed)
5. Clears pin: `clientPins.delete(clientId)`

**No clientId → no pinning:**
- If client has no `clientId`, on-hold session releases immediately (normal release)
- No hold timer, no pinning

### Implementation (relay-server.js)

**Intercept in `routeFromCli()`:**
```js
// Detect ask_user → mark on-hold
if (msg.params?.event?.type === 'external_tool.requested' &&
    msg.params.event.data?.toolName === 'ask_user') {
    entry.state = 'on-hold';
    entry.holdInfo = { requestId, question, timestamp };
}

// Detect completion → clear hold
if (msg.params?.event?.type === 'external_tool.completed') {
    if (entry.state === 'on-hold') {
        entry.state = 'active';
        entry.holdInfo = null;
    }
}
```

**Modified `releaseSession()`:**
```js
if (entry.state === 'on-hold' && clientId) {
    // Don't release — pin and start timer
    this.clientPins.set(clientId, sid);
    entry.holdTimer = setTimeout(() => this.expireHeldSession(sid, clientId), HOLD_TIMEOUT);
    return;
}
// Normal release → back to pool
```

**`expireHeldSession()` — the full hold expiry flow:**
```js
async expireHeldSession(sid, clientId) {
    // 1. Snapshot workspace
    const zipBuf = zipDirectory(entry.workspacePath);
    this.clientSnapshots.set(clientId, { buffer: zipBuf, timestamp: Date.now() });

    // 2. Auto-answer ask_user
    cli.stdin.write(frame({
        method: 'session.tools.handlePendingToolCall',
        params: { sessionId: sid, requestId: entry.holdInfo.requestId,
                  result: 'User disconnected. Session on hold expired.' }
    }));

    // 3. Release to pool (stale context kept, NOT destroyed)
    entry.state = 'available';
    this.available.push(sid);
    this.clientPins.delete(clientId);
}
```

### Config
- `HOLD_TIMEOUT`: Default 600000ms (10 min), env var override

---

## 2. Context Recovery (Workspace Snapshots)

### Problem
After hold timeout, the session goes back to pool with stale context. The original user's conversation is lost. We need to preserve it.

### Approach: tar.gz Snapshot → Deliver to Client

**Session workspace structure** (from CLI):
```
~/.copilot/session-state/default-pool-0/
  workspace.yaml      ← session metadata
  events.jsonl        ← full conversation history (~10KB)
  checkpoints/        ← checkpoint files
  files/              ← created files
  research/           ← research data
```

Total size: ~10-20KB per session (very small, highly compressible).

**Snapshot flow:**
1. Hold expires → `zipDirectory(workspacePath)` creates tar.gz (~10KB)
2. Stored server-side: `clientSnapshots.set(clientId, { buffer, timestamp })`
3. Client reconnects → `session.create` with `clientId`
4. Response includes `snapshot` (base64-encoded tar.gz) + `snapshotTimestamp`
5. Client stores snapshot locally (iOS: Documents directory)
6. Snapshot also restored server-side to new session's workspace

**Client can also send snapshot back:**
```json
{
  "method": "session.create",
  "params": {
    "clientId": "device-ABC",
    "snapshot": "<base64 tar.gz>"
  }
}
```
Relay unzips to new session's `workspacePath`.

**Snapshot cleanup:**
- Server-side snapshots expire after 1 hour (periodic cleanup every 5 min)
- Client can persist indefinitely

**Wire format:**
```json
// session.create response with snapshot
{
  "result": {
    "sessionId": "default-pool-2",
    "snapshot": "H4sIAAAAAAAAA+3T...",   // base64 tar.gz
    "snapshotTimestamp": 1711540248461
  }
}
```

### Implementation
```js
function zipDirectory(dirPath) {
    return execSync(`tar -czf - -C "${dirPath}" .`, { maxBuffer: 50 * 1024 * 1024 });
}

function unzipToDirectory(buffer, dirPath) {
    const tmpFile = path.join(os.tmpdir(), `relay-snapshot-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpFile, buffer);
    execSync(`tar -xzf "${tmpFile}" -C "${dirPath}"`);
    fs.unlinkSync(tmpFile);
}
```

---

## 3. Multi-Workspace (Multi-App)

### Problem
Different apps need different workspaces with their own instructions, skills, and files.

### Key CLI Behavior
- CLI has NO `--workspace` flag
- CLI uses `cwd` (current working directory) as workspace
- CLI reads `.github/copilot-instructions.md` from workspace
- `--add-dir <directory>` adds allowed file paths
- Each CLI process = one workspace

### Architecture: One CLI Per Workspace

Each app/workspace gets its own `PoolProxy` instance with its own CLI process:

```
WorkspaceManager
  ├── "intento" → PoolProxy → CLI (cwd: /apps/intento) → pool-0, pool-1, pool-2
  ├── "bullx"   → PoolProxy → CLI (cwd: /apps/bullx)   → pool-0, pool-1
  └── "default" → PoolProxy → CLI (cwd: ~)              → pool-0, pool-1, pool-2
```

### Config: workspaces.json

```json
{
  "intento": {
    "path": "/Users/chengli/Workspace/free2/intento",
    "poolSize": 3,
    "model": "gpt-4.1",
    "systemMessage": "You are the Intento camera agent...",
    "extraCliFlags": ["--add-dir", "/tmp"]
  },
  "bullx": {
    "path": "/Users/chengli/Workspace/free2/bullx",
    "poolSize": 2,
    "model": "claude-sonnet-4.6",
    "systemMessage": {
      "mode": "customize",
      "sections": {
        "tone": { "action": "replace", "content": "Be thorough and critical." },
        "guidelines": { "action": "append", "content": "\n* Always cite data sources" }
      },
      "content": "Focus on financial analysis and reporting."
    }
  }
}
```

Config resolution order:
1. `WORKSPACES` env var → path to JSON file
2. `./workspaces.json` in relay directory
3. Default: single "default" workspace with `cwd: ~`

### Client Routing

Client sends `appId` in `session.create`:
```json
{
  "method": "session.create",
  "params": {
    "appId": "intento",
    "clientId": "device-ABC"
  }
}
```

Relay routes to correct `PoolProxy` via `WorkspaceManager.getProxy(appId)`. Falls back to "default" workspace if `appId` not found.

### Session Scope: Shared Pool Per App

Sessions within an app's pool are interchangeable among all users. Each user can be pinned to a session via `clientId` (see Section 1), but the pool itself is shared.

### Workspace Directory Layout

Each workspace should have:
```
/apps/intento/
  .github/
    copilot-instructions.md   ← loaded by CLI automatically
  skills/                     ← custom skills
  mcp-config.json             ← MCP server configs
  ...project files...
```

---

## 4. Complete Session Lifecycle

### Full State Diagram

```
                  ┌──────────────────────────────────────────────────┐
                  │                  PoolProxy                       │
                  │                                                  │
  [startup]──→ creating ──→ available ──→ active ──→ on-hold        │
                  ↑            ↑           │           │   │        │
                  │            │           │           │   │        │
                  │            │    [disconnect]  [reconnect] [timeout]
                  │            │           │           │         │  │
                  │            │           ↓           ↓         │  │
                  │            └─── available   active(resumed)  │  │
                  │            └────────────────────── snapshot ←─┘  │
                  │                                    + auto-answer │
                  │                                    + available   │
                  └──────────────────────────────────────────────────┘
```

### What Happens to Context?

| Event | Context Behavior |
|-------|-----------------|
| Normal disconnect | Session returns to pool with stale context |
| Reconnect during hold | Same session, full context preserved |
| Hold timeout expires | Workspace snapshotted, session returns to pool with stale context |
| Reconnect after expiry | New session, snapshot delivered to client (+ restored to session workspace) |
| Client sends snapshot | Restored to new session workspace |
| Snapshot > 1 hour old | Cleaned up server-side |

### Wire Protocol Extensions

All `session.create` params:
```json
{
  "appId": "intento",      // → routes to correct workspace CLI/pool
  "clientId": "device-ABC", // → enables session pinning
  "snapshot": "<base64>"    // → restore workspace from client-provided snapshot
}
```

`session.create` response (when resumed):
```json
{
  "sessionId": "intento-pool-0",
  "resumed": true,
  "pendingQuestion": {"question": "What would you like to do next?"}
}
```

`session.create` response (with snapshot):
```json
{
  "sessionId": "intento-pool-2",
  "snapshot": "<base64 tar.gz>",
  "snapshotTimestamp": 1711540248461
}
```

---

## 5. Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8765 | WebSocket listen port |
| `CLI_PATH` | auto-detect | Path to `copilot` CLI binary |
| `POOL_SIZE` | 3 | Default pool size per workspace |
| `LOG_LEVEL` | info | `info` or `debug` |
| `MODEL` | gpt-4.1 | Default model |
| `HOLD_TIMEOUT` | 600000 | Hold timeout in ms (10 min) |
| `WORKSPACES` | null | Path to workspaces.json |
| `AGENT_INSTRUCTIONS` | (none) | Base system message (string only; use workspaces.json for objects) |

### System Message Customization

The relay uses `buildSessionSystemMessage()` to compose the system prompt. Agent loop instructions are always injected into the `last_instructions` section via `customize` mode. The workspace config's `systemMessage` can be:

| Input Format | Behavior |
|---|---|
| `undefined` / not set | `customize` mode with agent loop in `last_instructions` only |
| `"string"` | `customize` mode with string as `content` + agent loop in `last_instructions` |
| `{ mode: "customize", sections: {...}, content?: "..." }` | Merges sections + agent loop in `last_instructions` |
| `{ mode: "replace", content: "..." }` | `replace` mode with content + agent loop appended |

Available section IDs: `identity`, `tone`, `tool_efficiency`, `environment_context`, `code_change_rules`, `guidelines`, `safety`, `tool_instructions`, `custom_instructions`, `last_instructions`.

Each section supports actions: `replace`, `remove`, `append`, `prepend`.

Example (workspaces.json):
```json
{
  "my-app": {
    "systemMessage": {
      "mode": "customize",
      "sections": {
        "tone": { "action": "replace", "content": "Be warm and professional." },
        "code_change_rules": { "action": "remove" },
        "guidelines": { "action": "append", "content": "\n* Always cite sources" }
      },
      "content": "Focus on financial analysis."
    }
  }
}
```

The agent loop instructions (`send_response` + `ask_user` tool usage) are always injected regardless of the systemMessage config.

### Files

| File | Purpose |
|------|---------|
| `relay-server.js` | v2 relay (725 lines) |
| `relay-server-v1.js` | v1 backup (380 lines) |
| `relay-server-simple.js` | Original 1:1 relay (111 lines) |
| `workspaces.json` | Multi-workspace config (optional) |
| `test-client.js` | Basic flow test |
| `test-pool.js` | Pool behavior test |
| `test-stress.js` | Stress tests |
| `test-edge.js` | Edge case tests |
| `test-agent.js` | Agent loop test |
| `test-v2.js` | v2 feature tests (hold, pinning, snapshots) |
| `test-multiuser.js` | Multi-user session swap with snapshots |
| `test-recovery.js` | Context recovery across disconnect/reconnect |

---

## 6. Test Coverage

### v1 Tests (still passing on v2)
- **test-client.js**: create → send → response → disconnect ✓
- **test-agent.js**: send_response + ask_user tool calls ✓

### v2 Tests (test-v2.js) — 12/12 passed
1. ask_user → session on-hold ✓
2. Model called send_response ✓
3. Model called ask_user (left pending) ✓
4. Reconnect → session resumed ✓
5. Same session ID ✓
6. Pending question present ✓
7. Hold timeout → snapshot created (20KB) ✓
8. Not resumed after expiry ✓
9. Snapshot received ✓
10. Normal disconnect → immediate release ✓
11. Not resumed (normal release) ✓
12. No clientId → no pinning ✓

### Multi-User Tests (test-multiuser.js) — 16/16 passed
1. User A connects, establishes context ✓
2. User A: model called send_response ✓
3. User A: model called ask_user (session on-hold) ✓
4. User A disconnects → session on-hold ✓
5. User B gets different session ✓
6. User B: not a resumed session ✓
7. User B: model called send_response ✓
8. Hold timeout expires → snapshot captured ✓
9. User A reconnects → not resumed after expiry ✓
10. User A gets different session ✓
11. User A receives snapshot (20KB) ✓
12. User A sends snapshot back → applied to new session ✓
13. User A model responds after snapshot restore ✓
14. Two concurrent users get separate sessions ✓
15. Concurrent X and Y both interact ✓
16. Both disconnect cleanly ✓

### Recovery Test (test-recovery.js)
- Secret code (PHOENIX-42) preserved across disconnect/reconnect ✓

### Context Recovery from Snapshot

When a client reconnects after hold expiry (or sends a snapshot in `session.create`):
1. Relay restores snapshot to session workspace (tar.gz → files)
2. `extractConversationContext()` parses `events.jsonl` from the restored workspace
3. Extracts user messages and assistant `send_response` calls
4. Auto-injects summary as `session.send` prompt to new session
5. Model acknowledges restored context, client can continue where they left off

Proven in test-multiuser.js Phase 6: ALPHA-77 code recovered from snapshot → model said "Context restored."

### Relay Log Verification
```
Session default-pool-0 on-hold (ask_user)
Session default-pool-0 held for test-device-1 (5s)
Resumed pinned default-pool-0 for test-device-1
Hold expired: default-pool-1 (client test-device-2)
Snapshot saved for test-device-2 (10.0KB)
default-pool-1 returned to pool (available: 3)
Snapshot restore: ok
```

---

## 9. iOS CopilotSDK Integration

### SDK Changes (CopilotSDK/Sources/Client.swift)

| Component | Relay v2 Fields Added |
|-----------|----------------------|
| `SessionConfig` | `clientId`, `snapshot`, `appId` — sent in session.create params |
| `AgentConfig` | `clientId`, `snapshot`, `appId` — flow through to SessionConfig |
| `CopilotSession` | `resumed`, `pendingQuestion`, `pendingRequestId`, `snapshotData`, `snapshotTimestamp`, `recoveredContext` |
| `CopilotSession` | `answerPendingQuestion(answer:)` convenience method |
| `CopilotAgent.start()` | Auto-handles resumed sessions (answers pending ask_user instead of sending new prompt) |
| `CopilotSession.loop()` | Accepts optional `initialPrompt` (nil = skip initial send for resumed sessions) |

### App Integration (Intento/Services/)

**RelaySessionStore** (new singleton):
- `clientId`: Stable device UUID, generated once, persisted in UserDefaults
- `savedSnapshot`: Base64 snapshot from relay, saved/restored from UserDefaults
- `lastRelayHost/Port`: For reconnection

**Services updated** (CameraKitAgentViewModel, AgentLoop, AIDirectorService):
- Pass `store.clientId` + `store.savedSnapshot` in every session creation
- Save `session.snapshotData` to store when received from relay
- Clear snapshot on clean stop (session completed)

### Reconnection Flow

```
1. App disconnects (network drop, background, etc.)
2. Relay puts session on-hold (ask_user pending)
3. App calls reconnect(prompt:) or creates new client
4. New session.create with same clientId + saved snapshot
5a. If hold still active → resumed=true, pendingQuestion set
    → CopilotAgent answers pending ask_user, enters loop
5b. If hold expired → snapshot sent back, recoveredContext extracted
    → New session with context auto-injected by relay
```

### Test Coverage
- SDK: 79/79 tests pass (6 new relay v2 tests)
- Relay: test-v2.js 12/12, test-multiuser.js 17/17
- Xcode: BUILD SUCCEEDED (iPhone 17 Pro Simulator)
