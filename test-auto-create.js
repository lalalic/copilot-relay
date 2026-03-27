#!/usr/bin/env node
// Quick test: auto-create workspace for unknown appId
const ws = require('ws');

function frame(obj) {
    const j = JSON.stringify(obj);
    return `Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`;
}

class FP {
    buffer = Buffer.alloc(0);
    feed(d) {
        this.buffer = Buffer.concat([this.buffer, d instanceof Buffer ? d : Buffer.from(d)]);
        const m = [];
        while (true) {
            const h = this.buffer.indexOf('\r\n\r\n');
            if (h < 0) break;
            const mt = this.buffer.slice(0, h).toString().match(/Content-Length:\s*(\d+)/i);
            if (!mt) break;
            const l = parseInt(mt[1]);
            if (this.buffer.length < h + 4 + l) break;
            m.push(JSON.parse(this.buffer.slice(h + 4, h + 4 + l).toString()));
            this.buffer = this.buffer.slice(h + 4 + l);
        }
        return m;
    }
}

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8765';
const APP_ID = process.env.APP_ID || 'my-cool-app';

const c = new ws.WebSocket(RELAY_URL);
const p = new FP();

c.on('open', () => {
    console.log(`Connected to ${RELAY_URL}`);
    c.send(frame({ method: 'ping', id: 0 }));
    setTimeout(() => {
        console.log(`Creating session with appId: ${APP_ID}`);
        c.send(frame({
            jsonrpc: '2.0', id: 1,
            method: 'session.create',
            params: { model: 'gpt-4.1', appId: APP_ID, clientId: 'test-auto-create' },
        }));
    }, 500);
});

c.on('message', d => {
    for (const msg of p.feed(d)) {
        console.log('←', JSON.stringify(msg).slice(0, 200));
        if (msg.id === 1 && msg.result?.sessionId) {
            console.log(`\n✓ Auto-created workspace, got session: ${msg.result.sessionId}`);
            c.send(frame({
                jsonrpc: '2.0', id: 2,
                method: 'session.disconnect',
                params: { sessionId: msg.result.sessionId },
            }));
            setTimeout(() => process.exit(0), 1000);
        }
        if (msg.id === 1 && msg.error) {
            console.log(`\n✗ Error: ${msg.error.message}`);
            process.exit(1);
        }
    }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 45000);
