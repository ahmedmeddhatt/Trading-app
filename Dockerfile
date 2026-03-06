# ── Stage 1: prod dependencies ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
# --ignore-scripts skips postinstall; prisma generate runs explicitly after schema is present
RUN npm ci --omit=dev --ignore-scripts \
 && npx prisma generate

# ── Stage 2: TypeScript build ─────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate && npm run build

# ── Stage 3: production runner ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Debian places Chromium here
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium + Playwright system deps + dumb-init
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libasound2 \
    fonts-freefont-ttf \
    ca-certificates \
    dumb-init \
 && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nestjs \
 && chown -R nestjs:nodejs /app

COPY --from=deps    --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist         ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma       ./prisma

USER nestjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
