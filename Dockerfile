# ==============================================================================
# SoroTTL Keeper Daemon Containerfile
#
# STRICT SAFETY BOUNDARY:
# Non-custodial, read-only daemon. No transaction submission or secret key handling.
# ==============================================================================

# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json tsup.config.ts ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Production Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV SOROTTL_NETWORK=testnet
ENV SOROTTL_DB_PATH=/data/sorottl.db

# Ensure non-root user and persistent database directory
RUN mkdir -p /data && chown -R node:node /data /app

USER node

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# SQLite database volume
VOLUME ["/data"]

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["keeper:start"]
