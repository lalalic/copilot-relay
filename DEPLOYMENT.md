# Copilot Relay Deployment Analysis

## Current State

- **relay-server.js**: 953 lines, Node.js, single dependency (`ws`)
- **Runs locally** on Mac at `10.0.0.111:8765`
- **Copilot CLI**: macOS arm64 binary at `/opt/homebrew/bin/copilot`
- **Auth**: Uses local `~/.copilot/` credentials (GitHub Copilot subscription)
- **Clients**: iOS app on same LAN connecting via plain WebSocket

---

## What Needs to Change for Production

| Requirement | Current | Production |
|-------------|---------|------------|
| Network access | LAN only | Internet-accessible |
| Transport | `ws://` (plain) | `wss://` (TLS required by iOS ATS) |
| Domain | IP address | `relay.intento.app` or similar |
| Auth (GitHub) | Local `~/.copilot/` session | Service token or device flow on server |
| Auth (clients) | None | Token/API key to prevent abuse |
| CLI binary | macOS arm64 | Linux x64 (for server) or macOS on Mac host |
| Monitoring | `tail -f /tmp/relay-e2e.log` | Structured logging, health endpoint |
| Restart | Manual | systemd/Docker restart policy |

---

## Option 1: VPS with Direct Install

**Best for**: Low cost, full control, simple setup.

```
iPhone → wss://relay.intento.app → Caddy (TLS) → ws://localhost:8765 → relay-server.js → CLI
```

### Setup
1. **VPS**: Hetzner CX22 ($4.5/mo, 2 vCPU, 4GB RAM, Debian 12)
2. **Install Copilot CLI**: Download Linux x64 from GitHub releases or use npm
3. **Install Node.js**: `apt install nodejs npm`
4. **Deploy relay**: `git clone` + `npm install` + systemd service
5. **TLS**: Caddy auto-HTTPS with domain (free Let's Encrypt)
6. **Auth**: `COPILOT_GITHUB_TOKEN` in `.env`

### Caddy config
```
relay.intento.app {
    reverse_proxy localhost:8765
}
```

### systemd service
```ini
[Unit]
Description=Copilot Relay
After=network.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/copilot-relay
ExecStart=/usr/bin/node relay-server.js
Restart=always
RestartSec=5
Environment=PORT=8765
Environment=POOL_SIZE=3
EnvironmentFile=/opt/copilot-relay/.env

[Install]
WantedBy=multi-user.target
```

### Pros
- Cheapest option ($4.5/mo)
- Full control over CLI binary, environment
- Simple to debug (SSH in, check logs)
- Low latency (dedicated process)

### Cons
- Manual updates (CLI binary, relay code)
- Single point of failure
- Need to manage OS updates

---

## Option 2: Home Mac + Cloudflare Tunnel

**Best for**: Zero hosting cost, quick start, uses existing machine.

```
iPhone → wss://relay.intento.app → Cloudflare Edge → tunnel → localhost:8765 → relay-server.js → CLI
```

### Setup
1. **Cloudflare Tunnel**: `brew install cloudflared && cloudflared tunnel create relay`
2. **Config**: Route `relay.intento.app` to `ws://localhost:8765`
3. **Run tunnel**: `cloudflared tunnel run relay` (as LaunchAgent)
4. **Relay**: Already running locally

### Pros
- Free (Cloudflare Tunnel is free)
- No migration needed — keep using current setup
- CLI already authenticated locally
- DDoS protection from Cloudflare edge

### Cons
- Mac must stay on and connected
- Added latency (Cloudflare edge + tunnel round-trip)
- WebSocket support via Cloudflare can be finicky
- Not truly "deployed" — depends on home network

---

## Option 3: Docker on Any Server

**Best for**: Reproducible, portable deployment.

```
iPhone → wss://relay.intento.app → Caddy → ws://relay:8765 → Docker(relay + CLI)
```

### docker-compose.yml
```yaml
version: '3.8'
services:
  relay:
    build: .
    ports:
      - "8765:8765"
    environment:
      - PORT=8765
      - POOL_SIZE=3
      - COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN}
    restart: always
    volumes:
      - copilot-data:/root/.copilot

  caddy:
    image: caddy:2
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data

volumes:
  copilot-data:
  caddy-data:
```

### Dockerfile
```dockerfile
FROM node:22-slim

# Install Copilot CLI
RUN npm install -g @anthropic-ai/copilot-cli || \
    curl -fsSL https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-x64 -o /usr/local/bin/copilot && \
    chmod +x /usr/local/bin/copilot

WORKDIR /app
COPY package.json .
RUN npm install
COPY relay-server.js .

ENV PORT=8765 CLI_PATH=/usr/local/bin/copilot
EXPOSE 8765

CMD ["node", "relay-server.js"]
```

### Pros
- Reproducible across environments
- Easy to update (rebuild image)
- Can run on any Docker host (VPS, home server, etc.)

### Cons
- Need to figure out Copilot CLI Linux binary (may need to check exact download URL)
- Docker overhead (minimal but exists)
- Volume management for CLI state

---

## Option 4: fly.io / Railway (PaaS)

**Best for**: Zero-ops deployment with auto-scaling.

### fly.io
```toml
# fly.toml
app = "copilot-relay"
[env]
  PORT = "8765"
  POOL_SIZE = "3"
[http_service]
  internal_port = 8765
  force_https = true
[[services]]
  protocol = "tcp"
  internal_port = 8765
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

### Pros
- Auto-TLS, custom domain
- `fly deploy` from CLI
- Persistent volumes for CLI state
- Competitive pricing ($5-10/mo)

### Cons
- Process may sleep on free tier (bad for WebSocket)
- CLI binary installation in Dockerfile
- Less control over networking

---

## Critical Decision: Copilot CLI Authentication

The relay spawns `copilot --headless --stdio` which needs GitHub auth. Options:

### A: GitHub Copilot Token (Recommended for server)
```bash
# In .env on server
COPILOT_GITHUB_TOKEN=ghu_xxxx
```
The CLI accepts this for headless mode. Get from:
- GitHub Settings → Developer Settings → Personal Access Tokens → Classic
- Scope: `copilot` (if available) or use the token from `~/.copilot/hosts.json`

### B: Device Flow Auth
Run `copilot auth login` on the server once. Stores credentials in `~/.copilot/`.
Works but manual step after each deploy.

### C: GitHub App Token
For org deployment. More complex but proper for production SaaS.

**For now**: Option A — extract token from `~/.copilot/hosts.json` and set as env var.

---

## Client Authentication

Currently anyone who can reach the relay can use it. For production:

### Simple: Pre-shared API Key
```javascript
// In relay-server.js
wss.on('connection', (ws, req) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token !== process.env.RELAY_API_KEY) {
        ws.close(4001, 'Unauthorized');
        return;
    }
    // ... continue
});
```

iOS client adds header:
```swift
var request = URLRequest(url: relayURL)
request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
let ws = URLSessionWebSocketTask(with: request)
```

### Better: JWT with expiry
For multi-user. Sign tokens server-side, validate in relay.

**For now**: Pre-shared key is fine. Just you + testers.

---

## Recommended Path

### Phase 1: Quick Deploy (Today)
1. **Cloudflare Tunnel** from your Mac — zero cost, immediate
2. Add `RELAY_API_KEY` auth check to relay
3. Update iOS app to connect to `wss://relay.intento.app`
4. Test from cellular (not on LAN)

### Phase 2: Proper Deploy (When ready for users)
1. **Hetzner CX22** VPS ($4.5/mo)
2. Caddy for auto-TLS
3. systemd for process management
4. `COPILOT_GITHUB_TOKEN` from your account
5. API key auth for clients

### Phase 3: Scale (If needed)
1. Docker for reproducible deploys
2. Multiple relay instances behind load balancer
3. Redis for session state sharing (if multi-instance)

---

## Quick Reference: What to Do Right Now

```bash
# 1. Install cloudflared
brew install cloudflared

# 2. Login to Cloudflare (one-time)
cloudflared tunnel login

# 3. Create tunnel
cloudflared tunnel create copilot-relay

# 4. Route domain to tunnel
cloudflared tunnel route dns copilot-relay relay.intento.app

# 5. Create config
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: copilot-relay
credentials-file: /Users/chengli/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: relay.intento.app
    service: ws://localhost:8765
  - service: http_status:404
EOF

# 6. Run tunnel
cloudflared tunnel run copilot-relay

# 7. Add auth to relay-server.js (see client auth section above)

# 8. Update iOS app relay URL to wss://relay.intento.app
```
