# ==============================================================================
# SoroTTL Backend & Keeper Containerfile (Render Production Ready)
#
# STRICT SAFETY BOUNDARY:
# Non-custodial, read-only daemon and HTTP API.
# Zero transaction submission and zero secret key handling.
# ==============================================================================

# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

# Ensure native SQLite dependencies can compile if needed
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json tsup.config.ts ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Production Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV SOROTTL_NETWORK=testnet
ENV SOROTTL_DB_PATH=/var/data/sorottl.db
ENV SOROTTL_API_HOST=0.0.0.0
ENV PORT=8080

# Create persistent disk mount point and runtime app directory with safe permissions
RUN mkdir -p /var/data && chown -R node:node /var/data /app

USER node

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Persistent SQLite storage directory for Render Persistent Disk
VOLUME ["/var/data"]

EXPOSE 8080

# Starts combined keeper monitoring daemon and HTTP API server
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["keeper:start"]
