#!/usr/bin/env node
/**
 * Copilot CLI WebSocket Relay Server (Official SDK Protocol)
 * 
 * Bridges WebSocket connections from iOS devices to a local Copilot CLI process.
 * Uses the official SDK protocol: --headless --stdio with Content-Length framing.
 * 
 * Usage:
 *   node relay-server.js [port] [copilot-path]
 * 
 * Default port: 8765
 * Default CLI: searches common paths
 */

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = parseInt(process.argv[2]) || 8765;
const CLI_PATH = process.argv[3] || findCopilotCLI();

function findCopilotCLI() {
    const candidates = [
        '/opt/homebrew/bin/copilot',
        //path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'),
        //'/usr/local/bin/copilot',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    console.error('Copilot CLI not found. Pass path as argument: node relay-server.js 8765 /path/to/copilot');
    process.exit(1);
}

console.log(`Copilot CLI: ${CLI_PATH}`);
console.log(`Starting WebSocket relay on ws://0.0.0.0:${PORT}`);
console.log(`Protocol: Official SDK (--headless --stdio, Content-Length framing)`);

// Show local IP
const interfaces = os.networkInterfaces();
for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
            console.log(`  → ws://${addr.address}:${PORT}`);
        }
    }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
    console.log(`\n[${new Date().toISOString()}] Client connected from ${req.socket.remoteAddress}`);
    
    // Spawn CLI process with official SDK flags
    const cli = spawn(CLI_PATH, ['--headless', '--stdio', '--no-auto-update', '--log-level', 'error'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: os.homedir(),
    });
    
    console.log(`  CLI process started (PID: ${cli.pid})`);
    
    // CLI stdout → WebSocket
    // Content-Length framing is self-describing, so we can forward raw bytes.
    // The Swift SDK handles framing/deframing on its end.
    cli.stdout.on('data', (data) => {
        if (ws.readyState === 1) { // OPEN
            const msg = data.toString().trim();
            if (msg) console.log(`  CLI → WS: ${msg.substring(0, 500)}`);
            ws.send(data);
        }
    });
    
    cli.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`  CLI stderr: ${msg}`);
    });
    
    cli.on('close', (code) => {
        console.log(`  CLI process exited (code: ${code})`);
        if (ws.readyState === 1) ws.close();
    });
    
    // WebSocket → CLI stdin
    // Forward raw bytes — Content-Length framing from the Swift SDK
    ws.on('message', (data) => {
        if (cli.stdin.writable) {
            const msg = data.toString().trim();
            if (msg) console.log(`  WS → CLI: ${msg.substring(0, 500)}`);
            cli.stdin.write(data);
        }
    });
    
    ws.on('close', () => {
        console.log(`  Client disconnected`);
        cli.kill();
    });
    
    ws.on('error', (err) => {
        console.error(`  WebSocket error: ${err.message}`);
        cli.kill();
    });
});

wss.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
});

console.log('\nReady. Waiting for connections...\n');
