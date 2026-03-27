FROM node:22-bookworm-slim

# Download copilot CLI using node (avoid needing curl/apt on memory-limited VPS)
ARG COPILOT_CLI_VERSION=1.0.12
RUN node -e " \
  const https = require('https'); \
  const fs = require('fs'); \
  const { execSync } = require('child_process'); \
  const url = 'https://github.com/github/copilot-cli/releases/download/v${COPILOT_CLI_VERSION}/copilot-linux-x64.tar.gz'; \
  function follow(u, cb) { \
    https.get(u, {headers:{'User-Agent':'node'}}, r => { \
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { \
        follow(r.headers.location, cb); \
      } else { cb(r); } \
    }); \
  } \
  follow(url, r => { \
    const chunks = []; \
    r.on('data', d => chunks.push(d)); \
    r.on('end', () => { \
      fs.writeFileSync('/tmp/copilot.tar.gz', Buffer.concat(chunks)); \
      execSync('tar -xzf /tmp/copilot.tar.gz -C /usr/local/bin/'); \
      execSync('chmod +x /usr/local/bin/copilot'); \
      fs.unlinkSync('/tmp/copilot.tar.gz'); \
      console.log('Copilot CLI installed'); \
    }); \
  }); \
"

# Verify CLI is working
RUN /usr/local/bin/copilot --version

# Set up app
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY relay-server.js .

# CLI config volume (for auth state)
VOLUME /root/.copilot

ENV PORT=8765 \
    CLI_PATH=/usr/local/bin/copilot \
    POOL_SIZE=3 \
    LOG_LEVEL=info \
    MODEL=gpt-4.1

EXPOSE 8765

CMD ["node", "relay-server.js"]
