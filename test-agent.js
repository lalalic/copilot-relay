#!/usr/bin/env node
/**
 * Test agent loop behavior — verify the model uses send_response and ask_user tools.
 * 
 * Expected flow:
 * 1. Client sends session.create → gets pool session
 * 2. Client sends session.send with a prompt
 * 3. Model uses send_response tool → CLI emits external_tool.requested event
 * 4. Client handles tool call → sends session.tools.handlePendingToolCall
 * 5. Model calls ask_user → CLI emits another external_tool.requested
 * 6. Client answers → sends session.tools.handlePendingToolCall
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

async function test() {
    const ws = new WebSocket(RELAY_URL);
    const parser = new FrameParser();
    const responses = new Map();
    const allEvents = [];
    let rpcId = 1;

    ws.on('message', (data) => {
        for (const msg of parser.feed(data)) {
            // RPC response
            if (msg.id !== undefined && responses.has(msg.id)) {
                responses.get(msg.id)(msg);
                responses.delete(msg.id);
            }
            // Collect all events
            allEvents.push(msg);
        }
    });

    await new Promise(resolve => ws.on('open', resolve));
    console.log('Connected\n');

    function sendRpc(method, params) {
        const id = rpcId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                responses.delete(id);
                reject(new Error(`Timeout: ${method}`));
            }, 30000);
            responses.set(id, (msg) => { clearTimeout(timeout); resolve(msg); });
            ws.send(frame({ jsonrpc: '2.0', id, method, params }));
        });
    }

    function waitForEvent(predicate, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = setInterval(() => {
                const found = allEvents.find(predicate);
                if (found) { clearInterval(check); resolve(found); }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(check);
                    reject(new Error('Event timeout'));
                }
            }, 50);
        });
    }

    // --- Step 1: Create session ---
    console.log('=== Create Session ===');
    const createRes = await sendRpc('session.create', {});
    const sessionId = createRes.result.sessionId;
    console.log(`Session: ${sessionId}\n`);

    // --- Step 2: Send prompt ---
    console.log('=== Send Prompt ===');
    const sendRes = await sendRpc('session.send', {
        sessionId,
        prompt: 'What is 2 + 2? Give a brief answer.',
    });
    console.log(`Send accepted: messageId=${sendRes.result?.messageId}\n`);

    // --- Step 3: Wait for tool calls ---
    console.log('=== Waiting for agent tool calls ===');
    
    let toolCallCount = 0;
    const maxWait = 30000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        // Find unhandled external_tool.requested events
        const toolEvent = allEvents.find(e => 
            e.params?.event?.type === 'external_tool.requested' && 
            !e._handled
        );

        if (toolEvent) {
            toolEvent._handled = true;
            toolCallCount++;
            const data = toolEvent.params.event.data;
            console.log(`\nTool call #${toolCallCount}: ${data.toolName}`);
            console.log(`  requestId: ${data.requestId}`);
            console.log(`  arguments: ${JSON.stringify(data.arguments)}`);

            if (data.toolName === 'send_response') {
                // Handle send_response — acknowledge and return
                const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
                console.log(`  → Response message: "${args.message}"`);
                
                await sendRpc('session.tools.handlePendingToolCall', {
                    sessionId,
                    requestId: data.requestId,
                    result: 'Response delivered to user.',
                });
                console.log('  → Handled (response delivered)');
            } else if (data.toolName === 'ask_user') {
                const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
                console.log(`  → Question: "${args.question}"`);
                
                // Answer the question
                await sendRpc('session.tools.handlePendingToolCall', {
                    sessionId,
                    requestId: data.requestId,
                    result: 'User answered: No more questions, thanks!',
                });
                console.log('  → Handled (answered)');
                break; // Stop after ask_user — this completes the loop
            } else {
                console.log(`  → Unknown tool, returning error`);
                await sendRpc('session.tools.handlePendingToolCall', {
                    sessionId,
                    requestId: data.requestId,
                    error: `Unknown tool: ${data.toolName}`,
                });
            }
        }

        // Check for session.idle (turn ended without tool calls)
        const idleEvent = allEvents.find(e => 
            e.params?.event?.type === 'session.idle' && !e._checked
        );
        if (idleEvent) {
            idleEvent._checked = true;
            console.log('\n⚠ Session went idle without tool calls');
            
            // Check if there were assistant.message events (model responded directly)
            const msgs = allEvents.filter(e => e.params?.event?.type === 'assistant.message');
            if (msgs.length > 0) {
                const content = msgs[msgs.length - 1].params.event.data.content;
                console.log(`  Model responded directly: "${content}"`);
                console.log('  (Model may not have used send_response tool in this turn)');
            }
            break;
        }

        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n=== Summary ===`);
    console.log(`Tool calls handled: ${toolCallCount}`);
    console.log(`Total events received: ${allEvents.length}`);
    
    // Check for specific event types
    const eventTypes = {};
    for (const e of allEvents) {
        const type = e.params?.event?.type || e.method || 'response';
        eventTypes[type] = (eventTypes[type] || 0) + 1;
    }
    console.log('Event breakdown:');
    for (const [type, count] of Object.entries(eventTypes)) {
        console.log(`  ${type}: ${count}`);
    }

    if (toolCallCount > 0) {
        console.log('\n✓ Agent loop working — model used tools as instructed');
    } else {
        console.log('\n⚠ Agent did not use tools — may need to adjust system message');
    }

    // Cleanup
    await sendRpc('session.disconnect', { sessionId });
    ws.close();
}

test().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
