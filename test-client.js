#!/usr/bin/env node
/**
 * Test client for pool relay server.
 * Connects via WebSocket, creates a session, sends a prompt, reads response.
 */
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8765';
let rpcId = 1;

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

async function test() {
    console.log(`Connecting to ${RELAY_URL}`);
    const ws = new WebSocket(RELAY_URL);
    const parser = new FrameParser();

    const responses = new Map(); // id → resolve
    const events = [];

    ws.on('message', (data) => {
        for (const msg of parser.feed(data)) {
            console.log('← ', JSON.stringify(msg).slice(0, 300));
            
            // RPC response
            if (msg.id !== undefined && responses.has(msg.id)) {
                responses.get(msg.id)(msg);
                responses.delete(msg.id);
            }
            
            // Event notification
            if (msg.method === 'session.event') {
                events.push(msg);
            }
        }
    });

    await new Promise(resolve => ws.on('open', resolve));
    console.log('Connected!\n');

    function sendRpc(method, params) {
        const id = rpcId++;
        return new Promise((resolve) => {
            responses.set(id, resolve);
            ws.send(frame({ jsonrpc: '2.0', id, method, params }));
            console.log('→ ', JSON.stringify({ method, params }).slice(0, 200));
        });
    }

    // 1. Create session
    console.log('\n--- Test 1: Create Session ---');
    const createRes = await sendRpc('session.create', { model: 'gpt-4.1' });
    const sessionId = createRes.result?.sessionId;
    console.log(`Session ID: ${sessionId}`);
    if (!sessionId) {
        console.error('FAILED: No session ID returned');
        ws.close();
        return;
    }

    // 2. Send a prompt
    console.log('\n--- Test 2: Send Prompt ---');
    const sendRes = await sendRpc('session.send', {
        sessionId,
        prompt: 'Say exactly: "Pool relay works!" and nothing else.',
    });
    console.log('Send response:', JSON.stringify(sendRes).slice(0, 300));

    // 3. Wait for events
    console.log('\n--- Waiting for events (5s) ---');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log(`Received ${events.length} events`);
    for (const e of events.slice(0, 5)) {
        const evt = e.params?.event;
        console.log(`  [${evt?.type}]`, JSON.stringify(evt).slice(0, 200));
    }

    // 4. Disconnect
    console.log('\n--- Test 3: Disconnect ---');
    const discRes = await sendRpc('session.disconnect', { sessionId });
    console.log('Disconnect result:', JSON.stringify(discRes));

    ws.close();
    console.log('\n✓ All tests passed');
}

test().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
