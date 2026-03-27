#!/usr/bin/env node
/**
 * Edge case tests for pool relay server.
 * 
 * Tests:
 * 1. session.resume — should work like session.create (assign from pool)
 * 2. session.list — should return empty
 * 3. Double disconnect — disconnect same session twice
 * 4. Send without session — forward to CLI, expect error
 * 5. Concurrent sends on same session — should all be forwarded
 * 6. Rapid pool exhaustion — many clients at once, lazy expansion
 * 7. session.abort — should forward to CLI
 * 8. ping — should forward and return
 */
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8765';
let globalResults = { pass: 0, fail: 0, errors: [] };

function frame(obj) {
    const json = JSON.stringify(obj);
    return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

class FrameParser {
    buffer = Buffer.alloc(0);
    feed(data) {
        this.buffer = Buffer.concat([this.buffer, data instanceof Buffer ? data : Buffer.from(data)]);
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

async function createClient() {
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
            if (msg.method === 'session.event' || msg.method === 'session.lifecycle') {
                events.push(msg);
            }
        }
    });

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    return {
        ws, events,
        sendRpc(method, params, timeoutMs = 30000) {
            const id = rpcId++;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    responses.delete(id);
                    reject(new Error(`Timeout: ${method} id:${id}`));
                }, timeoutMs);
                responses.set(id, (msg) => { clearTimeout(timeout); resolve(msg); });
                ws.send(frame({ jsonrpc: '2.0', id, method, params }));
            });
        },
        close() { ws.close(); }
    };
}

function assert(condition, msg) {
    if (condition) {
        globalResults.pass++;
        console.log(`  ✓ ${msg}`);
    } else {
        globalResults.fail++;
        globalResults.errors.push(msg);
        console.log(`  ✗ ${msg}`);
    }
}

// --- Test 1: session.resume ---
async function testResume() {
    console.log('\n=== Test 1: session.resume ===');
    const c = await createClient();
    
    const r = await c.sendRpc('session.resume', { sessionId: 'old-session-123' });
    assert(r.result?.sessionId?.startsWith('pool-'), `resume returns pool session: ${r.result?.sessionId}`);
    
    await c.sendRpc('session.disconnect', { sessionId: r.result.sessionId });
    c.close();
}

// --- Test 2: session.list ---
async function testList() {
    console.log('\n=== Test 2: session.list ===');
    const c = await createClient();
    
    const r = await c.sendRpc('session.list', {});
    assert(Array.isArray(r.result) && r.result.length === 0, `list returns empty array`);
    
    c.close();
}

// --- Test 3: Double disconnect ---
async function testDoubleDisconnect() {
    console.log('\n=== Test 3: Double disconnect ===');
    const c = await createClient();
    
    const r = await c.sendRpc('session.create', {});
    const sid = r.result.sessionId;
    
    const d1 = await c.sendRpc('session.disconnect', { sessionId: sid });
    assert(d1.result !== undefined, 'First disconnect OK');
    
    const d2 = await c.sendRpc('session.disconnect', { sessionId: sid });
    assert(d2.result !== undefined, 'Second disconnect OK (no crash)');
    
    c.close();
}

// --- Test 4: Send without creating session ---  
async function testSendWithoutSession() {
    console.log('\n=== Test 4: Send without session ===');
    const c = await createClient();
    
    const r = await c.sendRpc('session.send', {
        sessionId: 'fake-session',
        prompt: 'hello',
    });
    
    // CLI should return an error
    assert(r.error !== undefined, `Got error for nonexistent session: ${r.error?.message}`);
    
    c.close();
}

// --- Test 5: Concurrent sends on same session ---
async function testConcurrentSends() {
    console.log('\n=== Test 5: Concurrent sends on same session ===');
    const c = await createClient();
    
    const r = await c.sendRpc('session.create', {});
    const sid = r.result.sessionId;
    
    // Send 3 prompts rapidly (without waiting for completion)
    const sends = await Promise.all([
        c.sendRpc('session.send', { sessionId: sid, prompt: 'Say "one".' }),
        c.sendRpc('session.send', { sessionId: sid, prompt: 'Say "two".' }),
        c.sendRpc('session.send', { sessionId: sid, prompt: 'Say "three".' }),
    ]);
    
    assert(sends.every(s => s.result?.messageId || s.error), 'All 3 sends got response/error');
    console.log(`  Send results: ${sends.map(s => s.result?.messageId ? 'OK' : `err:${s.error?.message}`).join(', ')}`);
    
    // Wait a bit for events
    await new Promise(r => setTimeout(r, 10000));
    const msgEvents = c.events.filter(e => e.params?.event?.type === 'assistant.message');
    console.log(`  Got ${msgEvents.length} assistant.message events`);
    assert(msgEvents.length >= 1, 'At least 1 assistant response received');
    
    await c.sendRpc('session.disconnect', { sessionId: sid });
    c.close();
}

// --- Test 6: Pool exhaustion burst ---
async function testPoolBurst() {
    console.log('\n=== Test 6: Pool exhaustion burst (8 simultaneous) ===');
    
    const clients = await Promise.all(
        Array.from({ length: 8 }, () => createClient())
    );
    
    const sessions = await Promise.all(
        clients.map(c => c.sendRpc('session.create', {}))
    );
    
    const sids = sessions.map(s => s.result?.sessionId).filter(Boolean);
    console.log(`  Sessions: ${sids.join(', ')}`);
    assert(sids.length === 8, `All 8 clients got sessions (got ${sids.length})`);
    
    const unique = new Set(sids);
    assert(unique.size === 8, `All 8 sessions unique (got ${unique.size})`);
    
    // Disconnect all
    await Promise.all(clients.map((c, i) => {
        if (sids[i]) return c.sendRpc('session.disconnect', { sessionId: sids[i] }).then(() => c.close());
        c.close();
    }));
}

// --- Test 7: session.abort ---
async function testAbort() {
    console.log('\n=== Test 7: session.abort ===');
    const c = await createClient();
    
    const r = await c.sendRpc('session.create', {});
    const sid = r.result.sessionId;
    
    // Start a long generation
    c.sendRpc('session.send', { sessionId: sid, prompt: 'Write a very long essay about clouds, at least 2000 words.' })
        .catch(() => {}); // ignore timeout
    
    await new Promise(r => setTimeout(r, 500));
    
    // Abort it
    const abortRes = await c.sendRpc('session.abort', { sessionId: sid });
    assert(abortRes.result !== undefined || abortRes.error !== undefined, 
        `Abort got response: ${JSON.stringify(abortRes).slice(0, 100)}`);
    
    await new Promise(r => setTimeout(r, 1000));
    await c.sendRpc('session.disconnect', { sessionId: sid });
    c.close();
}

// --- Test 8: ping ---
async function testPing() {
    console.log('\n=== Test 8: ping ===');
    const c = await createClient();
    
    const r = await c.sendRpc('ping', {});
    assert(r.result !== undefined, `Ping returned: ${JSON.stringify(r.result)}`);
    
    c.close();
}

// --- Run All ---
async function main() {
    console.log('Pool Relay Edge Case Tests');
    console.log('==========================');

    const tests = [
        testResume, testList, testDoubleDisconnect, testSendWithoutSession,
        testConcurrentSends, testPoolBurst, testAbort, testPing,
    ];

    for (const test of tests) {
        try {
            await test();
        } catch (e) {
            console.error(`  FATAL: ${e.message}`);
            globalResults.fail++;
            globalResults.errors.push(`${test.name}: ${e.message}`);
        }
    }

    console.log('\n==========================');
    console.log(`Results: ${globalResults.pass} passed, ${globalResults.fail} failed`);
    if (globalResults.errors.length > 0) {
        console.log('Failures:');
        for (const e of globalResults.errors) console.log(`  - ${e}`);
    }
    process.exit(globalResults.fail > 0 ? 1 : 0);
}

main();
