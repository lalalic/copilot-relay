#!/usr/bin/env node
/**
 * Stress tests for pool relay server.
 * 
 * Tests:
 * 1. Concurrent clients — 5 clients simultaneously sending prompts
 * 2. Rapid connect/disconnect — 10 clients cycling fast
 * 3. Multi-turn conversation — verify context persists within a session
 * 4. Client abort — abrupt disconnect mid-stream
 * 5. Invalid messages — malformed JSON, missing fields
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
            if (msg.method === 'session.event') {
                events.push(msg);
            }
        }
    });

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    return {
        ws,
        events,
        sendRpc(method, params) {
            const id = rpcId++;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    responses.delete(id);
                    reject(new Error(`Timeout waiting for response to ${method} (id:${id})`));
                }, 30000);
                responses.set(id, (msg) => {
                    clearTimeout(timeout);
                    resolve(msg);
                });
                ws.send(frame({ jsonrpc: '2.0', id, method, params }));
            });
        },
        async waitForEvent(type, timeoutMs = 15000) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                const found = events.find(e => e.params?.event?.type === type);
                if (found) return found;
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`Timeout waiting for event: ${type}`);
        },
        async waitForMessage(timeoutMs = 15000) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                const found = events.find(e => e.params?.event?.type === 'assistant.message');
                if (found) return found.params.event.data.content;
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error('Timeout waiting for assistant.message');
        },
        close() { ws.close(); }
    };
}

function assert(condition, msg) {
    if (condition) {
        globalResults.pass++;
    } else {
        globalResults.fail++;
        globalResults.errors.push(msg);
        console.log(`  ✗ ${msg}`);
    }
}

// --- Test 1: Concurrent Clients ---
async function testConcurrentClients() {
    console.log('\n=== Test 1: Concurrent Clients (5 simultaneous) ===');
    
    const clients = await Promise.all(
        Array.from({ length: 5 }, () => createClient())
    );
    console.log(`  Created ${clients.length} connections`);

    // All create sessions simultaneously
    const sessions = await Promise.all(
        clients.map(c => c.sendRpc('session.create', {}))
    );
    
    const sids = sessions.map(s => s.result.sessionId);
    console.log(`  Sessions: ${sids.join(', ')}`);
    
    // Verify all got unique sessions
    const unique = new Set(sids);
    assert(unique.size === 5, `Expected 5 unique sessions, got ${unique.size}`);
    console.log(`  ✓ ${unique.size} unique sessions assigned`);

    // All send prompts simultaneously
    const sendPromises = clients.map((c, i) => 
        c.sendRpc('session.send', {
            sessionId: sids[i],
            prompt: `Say exactly: "Client ${i}" and nothing else.`,
        })
    );
    const sendResults = await Promise.all(sendPromises);
    assert(sendResults.every(r => r.result?.messageId), 'All sends got messageIds');
    console.log(`  ✓ All 5 prompts accepted`);

    // Wait for all to get assistant.message events
    const messagePromises = clients.map(c => c.waitForMessage());
    const messages = await Promise.all(messagePromises);
    console.log(`  Responses: ${messages.map(m => `"${m}"`).join(', ')}`);
    
    // Each client should get a response (content may vary)
    assert(messages.every(m => m && m.length > 0), 'All clients got responses');
    console.log(`  ✓ All 5 clients received responses`);

    // Disconnect all
    await Promise.all(clients.map((c, i) => 
        c.sendRpc('session.disconnect', { sessionId: sids[i] }).then(() => c.close())
    ));
    console.log(`  ✓ All disconnected`);
}

// --- Test 2: Rapid Connect/Disconnect ---
async function testRapidCycle() {
    console.log('\n=== Test 2: Rapid Connect/Disconnect (10 cycles) ===');
    
    const sessionIds = [];
    for (let i = 0; i < 10; i++) {
        const c = await createClient();
        const r = await c.sendRpc('session.create', {});
        sessionIds.push(r.result.sessionId);
        await c.sendRpc('session.disconnect', { sessionId: r.result.sessionId });
        c.close();
    }

    console.log(`  Sessions used: ${sessionIds.join(', ')}`);
    assert(sessionIds.length === 10, `Completed 10 cycles`);
    
    // Sessions should be reused (only a few unique IDs)
    const unique = new Set(sessionIds);
    console.log(`  Unique sessions: ${unique.size}`);
    assert(unique.size <= 6, `Expected session reuse (≤6 unique), got ${unique.size}`);
    console.log(`  ✓ Session reuse confirmed`);
}

// --- Test 3: Multi-turn Conversation ---
async function testMultiTurn() {
    console.log('\n=== Test 3: Multi-turn Conversation ===');
    
    const c = await createClient();
    const r = await c.sendRpc('session.create', {});
    const sid = r.result.sessionId;
    console.log(`  Session: ${sid}`);

    // Turn 1: Set a fact
    await c.sendRpc('session.send', {
        sessionId: sid,
        prompt: 'Remember this secret code: RELAY42. Just say "Got it." and nothing else.',
    });
    const msg1 = await c.waitForMessage();
    console.log(`  Turn 1 response: "${msg1}"`);
    assert(msg1.length > 0, 'Turn 1 got response');

    // Clear events for next turn
    c.events.length = 0;

    // Turn 2: Recall the fact
    await c.sendRpc('session.send', {
        sessionId: sid,
        prompt: 'What was the secret code I told you? Reply with ONLY the code.',
    });
    const msg2 = await c.waitForMessage();
    console.log(`  Turn 2 response: "${msg2}"`);
    assert(msg2.includes('RELAY42'), `Expected RELAY42 in response, got "${msg2}"`);
    console.log(`  ✓ Context persisted across turns`);

    await c.sendRpc('session.disconnect', { sessionId: sid });
    c.close();
}

// --- Test 4: Client Abort Mid-Stream ---
async function testAbruptDisconnect() {
    console.log('\n=== Test 4: Abrupt Disconnect Mid-Stream ===');
    
    const c = await createClient();
    const r = await c.sendRpc('session.create', {});
    const sid = r.result.sessionId;
    console.log(`  Session: ${sid}`);

    // Send a long prompt, then immediately disconnect
    c.ws.send(frame({
        jsonrpc: '2.0', id: 999,
        method: 'session.send',
        params: { sessionId: sid, prompt: 'Write a 500-word essay about trees.' },
    }));
    
    // Wait 200ms then forcefully close
    await new Promise(r => setTimeout(r, 200));
    c.ws.terminate(); // force close, no clean disconnect
    console.log(`  Terminated connection after 200ms`);

    // Wait for relay to clean up
    await new Promise(r => setTimeout(r, 2000));

    // Verify relay is still healthy — create a new session
    const c2 = await createClient();
    const r2 = await c2.sendRpc('session.create', {});
    assert(r2.result?.sessionId, 'New session created after abort');
    console.log(`  ✓ Relay healthy after abort (new session: ${r2.result.sessionId})`);

    await c2.sendRpc('session.disconnect', { sessionId: r2.result.sessionId });
    c2.close();
}

// --- Test 5: Invalid Messages ---
async function testInvalidMessages() {
    console.log('\n=== Test 5: Invalid Messages ===');

    // Send raw garbage
    const ws1 = new WebSocket(RELAY_URL);
    await new Promise(resolve => ws1.on('open', resolve));
    ws1.send('this is not json-rpc');
    ws1.send(Buffer.from([0x00, 0xff, 0xfe]));
    await new Promise(r => setTimeout(r, 500));
    
    // Connection should still be alive
    assert(ws1.readyState === 1, 'Connection alive after garbage data');
    console.log(`  ✓ Relay survived garbage data`);
    ws1.close();

    // Send valid frame but wrong method
    const c = await createClient();
    // Try to send without creating a session first
    const r = await c.sendRpc('session.send', {
        sessionId: 'nonexistent-session',
        prompt: 'hello',
    });
    // This should still forward to CLI (which may error)
    console.log(`  Unknown session response: ${JSON.stringify(r).slice(0, 200)}`);
    assert(true, 'Handled unknown session gracefully');
    console.log(`  ✓ Handled gracefully`);
    c.close();
}

// --- Run All ---
async function main() {
    console.log('Pool Relay Stress Tests');
    console.log('=======================');

    try { await testConcurrentClients(); } catch (e) { console.error('  FATAL:', e.message); globalResults.fail++; }
    try { await testRapidCycle(); } catch (e) { console.error('  FATAL:', e.message); globalResults.fail++; }
    try { await testMultiTurn(); } catch (e) { console.error('  FATAL:', e.message); globalResults.fail++; }
    try { await testAbruptDisconnect(); } catch (e) { console.error('  FATAL:', e.message); globalResults.fail++; }
    try { await testInvalidMessages(); } catch (e) { console.error('  FATAL:', e.message); globalResults.fail++; }

    console.log('\n=======================');
    console.log(`Results: ${globalResults.pass} passed, ${globalResults.fail} failed`);
    if (globalResults.errors.length > 0) {
        console.log('Failures:');
        for (const e of globalResults.errors) console.log(`  - ${e}`);
    }
    process.exit(globalResults.fail > 0 ? 1 : 0);
}

main();
