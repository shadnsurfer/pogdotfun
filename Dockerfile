FROM node:22-bookworm-slim

WORKDIR /app

# Keep lockfile resolution identical to local and frontend builds.
RUN npm install --global npm@10.9.8 --no-audit --no-fund

# Install only the locked runtime dependencies; credentials are runtime variables.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server

ENV NODE_ENV=production \
    POG_LISTEN_HOST=0.0.0.0 \
    POG_DB_PATH=/data/pog.db \
    POG_AUTOMATION_ENABLED=false \
    POG_TRANSACTIONS_ENABLED=false

# Railway supplies PORT. Attach its persistent volume at /data before deploying.
CMD ["node", "--import", "tsx", "server/index.ts"]
