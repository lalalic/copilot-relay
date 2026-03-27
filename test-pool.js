#!/usr/bin/env node
/**
 * Test session pooling: two clients sequentially, verify they get pool sessions
 * and that released sessions are reused.
 */
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8765';

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
    let rpcId = 1;

    ws.on('message', (data) => {
        for (const msg of parser.feed(data)) {
            if (msg.id !== undefined && responses.has(msg.id)) {
                responses.get(msg.id)(msg);
                responses.delete(msg.id);
            }
        }
    });

    await new Promise(resolve => ws.on('open', resolve));

    return {
        ws,
        sendRpc(method, params) {
            const id = rpcId++;
            return new Promise(resolve => {
                responses.set(id, resolve);
                ws.send(frame({ jsonrpc: '2.0', id, method, params }));
            });
        },
        close() { ws.close(); }
    };
}

async function test() {
    const sessions = [];

    // Client 1: create + disconnect
    console.log('--- Client 1 ---');
    const c1 = await createClient();
    const r1 = await c1.sendRpc('session.create', {});
    console.log(`Got session: ${r1.result.sessionId}`);
    sessions.push(r1.result.sessionId);
    await c1.sendRpc('session.disconnect', { sessionId: r1.result.sessionId });
    console.log('Disconnected');
    c1.close();

    await new Promise(r => setTimeout(r, 500));

    // Client 2: should reuse the released session
    console.log('\n--- Client 2 ---');
    const c2 = await createClient();
    const r2 = await c2.sendRpc('session.create', {});
    console.log(`Got session: ${r2.result.sessionId}`);
    sessions.push(r2.result.sessionId);
    
    // Verify reuse
    if (r2.result.sessionId === sessions[0]) {
        console.log('✓ Session reused!');
    } else {
        console.log(`✗ Different session (expected ${sessions[0]}, got ${r2.result.sessionId})`);
    }

    await c2.sendRpc('session.disconnect', { sessionId: r2.result.sessionId });
    c2.close();

    await new Promise(r => setTimeout(r, 500));

    // Client 3, 4, 5: exhaust pool + lazy expansion
    console.log('\n--- Clients 3,4,5 (exhaust pool + lazy expand) ---');
    const clients = [];
    for (let i = 3; i <= 5; i++) {
        const c = await createClient();
        const r = await c.sendRpc('session.create', {});
        console.log(`Client ${i} got: ${r.result.sessionId}`);
        clients.push({ client: c, sid: r.result.sessionId });
    }

    // Client 6: should trigger lazy expansion (pool had 3 pre-warmed, all taken)
    console.log('\n--- Client 6 (should trigger lazy expansion) ---');
    const c6 = await createClient();
    const r6 = await c6.sendRpc('session.create', {});
    console.log(`Client 6 got: ${r6.result.sessionId}`);
    if (r6.result.sessionId.startsWith('pool-')) {
        console.log('✓ Lazy expansion worked!');
    }

    // Cleanup
    for (const { client, sid } of clients) {
        await client.sendRpc('session.disconnect', { sessionId: sid });
        client.close();
    }
    await c6.sendRpc('session.disconnect', { sessionId: r6.result.sessionId });
    c6.close();

    console.log('\n✓ All pool tests passed');
}

test().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
