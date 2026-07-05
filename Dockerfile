# ============================================================
# AI Customer Support Ticket Automation — Dockerfile
# ============================================================
# Multi-stage build for a small production image.
# Node.js 18 Alpine + build tools for better-sqlite3 native module.
# ============================================================

# ---- Stage 1: Build native dependencies (better-sqlite3) ----
FROM node:18-bookworm-slim AS builder

WORKDIR /app

# Install build tools needed by better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package.json package-lock.json* ./

# Install ALL dependencies (including dev) — we'll prune later
RUN npm ci --include=dev || npm install

# Copy source
COPY . .

# ---- Stage 2: Production runtime ----
FROM node:18-bookworm-slim AS runtime

WORKDIR /app

# Install runtime libs needed by better-sqlite3 (libstdc++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package.json package-lock.json* ./

# Copy node_modules from builder (already compiled for this architecture)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/data ./data
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/workflow.json ./workflow.json

# Create runtime directories
RUN mkdir -p /app/data /app/uploads /app/logs /app/backups

# Declare volumes so data persists across container restarts
VOLUME ["/app/data", "/app/uploads", "/app/logs", "/app/backups"]

# Expose the app port (configurable via PORT env)
EXPOSE 3000

# Healthcheck — hits /api/health every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as a non-root user for security
RUN useradd -r -u 1001 -g root appuser && chown -R appuser:root /app
USER appuser

# Start the server
CMD ["node", "server.js"]
