# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — deps (shared between dev and production)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — development  (ts-node-dev + inspector, no build step)
# Use: docker compose -f docker-compose.dev.yml up
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS development

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy only deps — source is mounted as a volume at runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./

# Expose app port + Node inspector port
EXPOSE 3000 9229

# Healthcheck (dev)
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD curl -sf http://localhost:3000/health || exit 1

# Default: overridden per-service in docker-compose.dev.yml
CMD ["node", "--inspect=0.0.0.0:9229", \
     "-r", "ts-node/register", \
     "src/index.ts"]


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — builder  (compile TypeScript → JS with source maps)
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --production


# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — production  (compiled JS, non-root user, no dev deps)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache curl \
 && addgroup -g 1001 -S nodejs \
 && adduser  -S appuser -u 1001

COPY --from=builder --chown=appuser:nodejs /app/dist         ./dist
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/package.json ./package.json

RUN mkdir -p logs && chown appuser:nodejs logs

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
