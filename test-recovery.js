#!/usr/bin/env node
/**
 * Test session.resume behavior — can CLI pick up restored session state?
 * 
 * Plan:
 *   1. Create session directly with CLI, send a message, note the context
 *   2. Disconnect session
 *   3. Try session.resume on the same session — does it pick up context?
 *   4. Copy session workspace to a different path
 *   5. Try session.resume on the copy — does CLI find it?
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

async function createClient() {
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

        ws.on('open', () => resolve({
            ws, events,
            send(method, params) {
                const id = rpcId++;
                return new Promise((res, rej) => {
                    const t = setTimeout(() => { responses.delete(id); rej(new Error(`Timeout: ${method}`)); }, 30000);
                    responses.set(id, m => { clearTimeout(t); res(m); });
                    ws.send(frame({ jsonrpc: '2.0', id, method, params }));
                });
            },
            close() { ws.close(); return new Promise(r => ws.on('close', r)); },
        }));
    });
}

async function handleToolsUntilAskUser(client, sessionId) {
    const handled = [];
    const start = Date.now();
    while (Date.now() - start < 25000) {
        const toolEvent = client.events.find(e =>
            e.params?.event?.type === 'external_tool.requested' && !e._handled
        );
        if (toolEvent) {
            toolEvent._handled = true;
            const data = toolEvent.params.event.data;
            handled.push(data);

            if (data.toolName === 'send_response') {
                const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
                console.log(`  [send_response] "${args.message}"`);
                await client.send('session.tools.handlePendingToolCall', {
                    sessionId, requestId: data.requestId, result: 'Delivered.',
                });
            } else if (data.toolName === 'ask_user') {
                const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
                console.log(`  [ask_user] "${args.question}"`);
                return { tools: handled, askUserRequestId: data.requestId };
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return { tools: handled, askUserRequestId: null };
}

async function main() {
    console.log('=== Test: Session context recovery ===\n');

    // Session 1: Create and establish context
    console.log('--- Step 1: Create session, give it a secret ---');
    const c1 = await createClient();
    const res1 = await c1.send('session.create', { clientId: 'recovery-test' });
    const sid = res1.result.sessionId;
    console.log(`Session: ${sid}`);

    await c1.send('session.send', {
        sessionId: sid,
        prompt: 'Remember this secret code: PHOENIX-42. Confirm you got it using send_response, then ask me what to do next using ask_user.',
    });
    
    // Handle tool calls — need to get to a state where ask_user is pending
    let askUserRequestId = null;
    const maxAttempts = 3;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await handleToolsUntilAskUser(c1, sid);
        if (result.askUserRequestId) {
            askUserRequestId = result.askUserRequestId;
            break;
        }
        // Model didn't call ask_user — send another prompt to trigger it
        if (attempt < maxAttempts - 1) {
            console.log('  (Model didn\'t call ask_user, sending follow-up...)');
            await c1.send('session.send', {
                sessionId: sid,
                prompt: 'Now use the ask_user tool to ask me what I want to do next. Do NOT end your turn without calling ask_user.',
            });
        }
    }

    if (!askUserRequestId) {
        console.log('  ✗ Could not get model to call ask_user — cannot test hold');
        await c1.close();
        return;
    }

    console.log('  ask_user is pending, NOT answering it');

    // Now disconnect (hold should trigger since ask_user pending)
    console.log(`\n--- Step 2: Disconnect (session should go on-hold) ---`);
    await c1.close();
    console.log('Disconnected.\n');

    // Wait a moment
    await new Promise(r => setTimeout(r, 2000));

    // Reconnect with same clientId — should resume pinned session
    console.log('--- Step 3: Reconnect → test if context preserved ---');
    const c2 = await createClient();
    const res2 = await c2.send('session.create', { clientId: 'recovery-test' });
    console.log(`Resumed: ${res2.result.resumed}, Session: ${res2.result.sessionId}`);
    console.log(`Same session: ${res2.result.sessionId === sid}`);

    if (res2.result.pendingQuestion) {
        console.log(`Pending question: ${JSON.stringify(res2.result.pendingQuestion)}`);
    }

    // Now ask about the secret
    console.log('\n--- Step 4: Ask about the secret code ---');

    // Answer the pending ask_user first (if exists)
    if (res2.result.pendingRequestId) {
        await c2.send('session.tools.handlePendingToolCall', {
            sessionId: res2.result.sessionId,
            requestId: res2.result.pendingRequestId,
            result: 'What was the secret code I told you to remember?',
        });
        console.log('  Answered pending ask_user with secret code question');
    } else {
        // Send as new prompt
        await c2.send('session.send', {
            sessionId: res2.result.sessionId,
            prompt: 'What was the secret code I told you to remember?',
        });
    }

    const result2 = await handleToolsUntilAskUser(c2, res2.result.sessionId);

    console.log(`\n--- Summary ---`);
    console.log(`Tools called: ${result2.tools.length}`);
    const response = result2.tools.find(t => t.toolName === 'send_response');
    if (response) {
        const args = typeof response.arguments === 'string' ? JSON.parse(response.arguments) : response.arguments;
        const hasSecret = args.message?.includes('PHOENIX-42');
        console.log(`Response mentions PHOENIX-42: ${hasSecret}`);
        if (hasSecret) {
            console.log('✓ Context preserved across reconnect!');
        } else {
            console.log('✗ Context NOT preserved — model forgot the secret');
        }
    }

    await c2.send('session.disconnect', { sessionId: res2.result.sessionId });
    await c2.close();
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
