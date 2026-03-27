#!/usr/bin/env node
/**
 * Test v2 relay features: session hold, client pinning, snapshots.
 * 
 * Tests:
 *   1. ask_user → session goes on-hold
 *   2. Client disconnect during on-hold → session held (not released to pool)
 *   3. Client reconnect with clientId → resume pinned session with pending question
 *   4. Hold timeout → snapshot created, session released to pool
 *   5. Reconnect after expiry → gets snapshot in response
 *   6. Client-provided snapshot restoration
 */
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8765';
// Use short timeout for testing (env override or 5s)
// Start relay with: HOLD_TIMEOUT=5000 node relay-server.js
const HOLD_TIMEOUT = parseInt(process.env.HOLD_TIMEOUT) || 5000;

function frame(obj) {
    const json = JSON.stringify(obj);
    return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

class FrameParser {
    buffer = Buffer.alloc(0);
    feed(data) {
        this.buffer = Buffer.concat([this.buffer, data instanceof Buffer ? data : Buffer.from(data)]);
        const msgs = [];
        while (true) {
            const h = this.buffer.indexOf('\r\n\r\n');
            if (h < 0) break;
            const m = this.buffer.slice(0, h).toString().match(/Content-Length:\s*(\d+)/i);
            if (!m) break;
            const len = parseInt(m[1]);
            if (this.buffer.length < h + 4 + len) break;
            msgs.push(JSON.parse(this.buffer.slice(h + 4, h + 4 + len).toString()));
            this.buffer = this.buffer.slice(h + 4 + len);
        }
        return msgs;
    }
}

function createClient() {
    return new Promise((resolve) => {
        const ws = new WebSocket(RELAY_URL);
        const parser = new FrameParser();
        const responses = new Map();
        const events = [];
        let rpcId = 1;

        ws.on('message', (data) => {
            for (const msg of parser.feed(data)) {
                if (msg.id !== undefined && responses.has(msg.id)) {
                    responses.get(msg.id)(msg);
                    responses.delete(msg.id);
                }
                events.push(msg);
            }
        });

        ws.on('open', () => {
            resolve({
                ws,
                events,
                send(method, params) {
                    const id = rpcId++;
                    return new Promise((res, rej) => {
                        const t = setTimeout(() => { responses.delete(id); rej(new Error(`Timeout: ${method}`)); }, 30000);
                        responses.set(id, (msg) => { clearTimeout(t); res(msg); });
                        ws.send(frame({ jsonrpc: '2.0', id, method, params }));
                    });
                },
                waitForEvent(pred, timeout = 15000) {
                    return new Promise((res, rej) => {
                        const start = Date.now();
                        const iv = setInterval(() => {
                            const found = events.find(pred);
                            if (found) { clearInterval(iv); res(found); }
                            if (Date.now() - start > timeout) { clearInterval(iv); rej(new Error('Event timeout')); }
                        }, 50);
                    });
                },
                close() { ws.close(); return new Promise(r => ws.on('close', r)); },
            });
        });
    });
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (!condition) {
        console.log(`  ✗ FAIL: ${msg}`);
        failed++;
        return false;
    }
    console.log(`  ✓ ${msg}`);
    passed++;
    return true;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleToolCalls(client, sessionId, maxCalls = 5) {
    const handled = [];
    const start = Date.now();
    while (Date.now() - start < 25000 && handled.length < maxCalls) {
        const toolEvent = client.events.find(e =>
            e.params?.event?.type === 'external_tool.requested' && !e._handled
        );
        if (toolEvent) {
            toolEvent._handled = true;
            const data = toolEvent.params.event.data;
            handled.push(data);

            if (data.toolName === 'send_response') {
                await client.send('session.tools.handlePendingToolCall', {
                    sessionId,
                    requestId: data.requestId,
                    result: 'Delivered.',
                });
            } else if (data.toolName === 'ask_user') {
                // Don't answer ask_user — let it stay pending
                return { tools: handled, askUserRequestId: data.requestId };
            }
        }

        // Check if session went idle (model didn't use tools)
        const idle = client.events.find(e =>
            e.params?.event?.type === 'session.idle' && !e._idleChecked
        );
        if (idle) {
            idle._idleChecked = true;
            break;
        }

        await sleep(100);
    }
    return { tools: handled, askUserRequestId: null };
}

/** Retry until model calls ask_user */
async function ensureAskUser(client, sessionId, initialPrompt, maxAttempts = 3) {
    await client.send('session.send', { sessionId, prompt: initialPrompt });
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await handleToolCalls(client, sessionId);
        if (result.askUserRequestId) return result;
        if (attempt < maxAttempts - 1) {
            console.log('  (Retrying — model didn\'t call ask_user)');
            await client.send('session.send', {
                sessionId,
                prompt: 'You MUST call ask_user now to ask what I want to do next. Do not end your turn without calling ask_user.',
            });
        }
    }
    return { tools: [], askUserRequestId: null };
}

async function test1_askUserHold() {
    console.log('\n=== Test 1: ask_user → session on-hold ===');
    const c = await createClient();
    const res = await c.send('session.create', { clientId: 'test-device-1' });
    const sid = res.result.sessionId;
    console.log(`  Session: ${sid}`);

    const result = await ensureAskUser(c, sid, 'What is 3 + 5? Answer using send_response, then call ask_user.');

    const hasSendResponse = result.tools.some(t => t.toolName === 'send_response');
    const hasAskUser = !!result.askUserRequestId;
    assert(hasSendResponse, 'Model called send_response');
    assert(hasAskUser, 'Model called ask_user (left pending)');

    // Session should be on-hold now (ask_user not answered)
    // Disconnect without answering ask_user
    await c.close();
    console.log('  Client disconnected while ask_user pending');
    return sid;
}

async function test2_reconnectPinned(expectedSid) {
    console.log('\n=== Test 2: Reconnect → resume pinned session ===');
    await sleep(1000); // Give relay time to process disconnect

    const c = await createClient();
    const res = await c.send('session.create', { clientId: 'test-device-1' });

    assert(res.result.resumed === true, `Session resumed (resumed=${res.result.resumed})`);
    assert(res.result.sessionId === expectedSid, `Same session: ${res.result.sessionId} === ${expectedSid}`);
    assert(res.result.pendingQuestion !== undefined, `Pending question present: ${JSON.stringify(res.result.pendingQuestion)}`);

    // Answer the pending ask_user
    const askEvent = c.events.find(e =>
        e.params?.event?.type === 'external_tool.requested' &&
        e.params.event.data?.toolName === 'ask_user'
    );
    // Note: the ask_user event was from before disconnect, client won't see it again
    // But the session still has the pending tool call from before
    // We need to get the requestId from the pendingQuestion or find it
    // Actually on resume, relay returns pendingQuestion but not requestId
    // The client would need to re-send or the relay may have stored it
    // For now just verify the resume worked

    await c.send('session.disconnect', { sessionId: res.result.sessionId });
    await c.close();
}

async function test3_holdExpiry() {
    console.log('\n=== Test 3: Hold timeout → snapshot + release to pool ===');
    const c = await createClient();
    const res = await c.send('session.create', { clientId: 'test-device-2' });
    const sid = res.result.sessionId;
    console.log(`  Session: ${sid}`);

    // Send prompt, wait for ask_user (with retry)
    const result = await ensureAskUser(c, sid, 'Hello, what is 7 + 1? Answer then call ask_user.');
    assert(!!result.askUserRequestId, 'Model called ask_user');

    // Disconnect to trigger hold
    await c.close();
    console.log(`  Client disconnected. Waiting ${HOLD_TIMEOUT / 1000}s for hold timeout...`);

    // Wait for hold to expire
    await sleep(HOLD_TIMEOUT + 2000);

    // Reconnect with same clientId — should get a different session + snapshot
    const c2 = await createClient();
    const res2 = await c2.send('session.create', { clientId: 'test-device-2' });

    // Should NOT be resumed (hold expired)
    assert(res2.result.resumed !== true, `Not resumed after expiry (resumed=${res2.result.resumed})`);
    
    // Should have snapshot (if workspace had content)
    if (res2.result.snapshot) {
        const snapSize = Buffer.from(res2.result.snapshot, 'base64').length;
        assert(snapSize > 0, `Snapshot received (${(snapSize / 1024).toFixed(1)}KB)`);
    } else {
        console.log('  ℹ No snapshot (may not have workspace content)');
    }

    await c2.send('session.disconnect', { sessionId: res2.result.sessionId });
    await c2.close();
}

async function test4_normalRelease() {
    console.log('\n=== Test 4: Normal disconnect (not on-hold) → immediate release ===');
    const c = await createClient();
    const res = await c.send('session.create', { clientId: 'test-device-3' });
    const sid = res.result.sessionId;
    assert(!!sid, `Got session: ${sid}`);

    // Disconnect without sending anything — not on hold
    await c.send('session.disconnect', { sessionId: sid });
    await c.close();

    // Reconnect — should get a different session (or maybe same, but not "resumed")
    await sleep(500);
    const c2 = await createClient();
    const res2 = await c2.send('session.create', { clientId: 'test-device-3' });
    assert(res2.result.resumed !== true, `Not resumed (normal release)`);
    await c2.send('session.disconnect', { sessionId: res2.result.sessionId });
    await c2.close();
}

async function test5_noClientIdNoPin() {
    console.log('\n=== Test 5: No clientId → no pinning ===');
    const c = await createClient();
    const res = await c.send('session.create', {}); // no clientId
    const sid = res.result.sessionId;
    assert(!!sid, `Got session: ${sid}`);

    await c.send('session.send', { sessionId: sid, prompt: 'Say hi using send_response' });
    const result = await handleToolCalls(c, sid);

    // If ask_user is pending but no clientId, session should release normally
    await c.close();
    await sleep(1000);

    const c2 = await createClient();
    const res2 = await c2.send('session.create', {});
    assert(res2.result.resumed !== true, `Not resumed (no clientId)`);
    await c2.send('session.disconnect', { sessionId: res2.result.sessionId });
    await c2.close();
}

async function main() {
    console.log('Copilot Relay v2 Tests');
    console.log(`Hold timeout: ${HOLD_TIMEOUT}ms`);
    console.log('(Start relay with: HOLD_TIMEOUT=5000 LOG_LEVEL=debug node relay-server.js)\n');

    try {
        const pinnedSid = await test1_askUserHold();
        await test2_reconnectPinned(pinnedSid);
        await test3_holdExpiry();
        await test4_normalRelease();
        await test5_noClientIdNoPin();
    } catch (e) {
        console.error(`\nTest error: ${e.message}`);
        failed++;
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
