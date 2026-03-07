# ── Stage 1: production dependencies ─────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
# node:20-slim is debian:bookworm-slim + Node 20 — no curl/NodeSource needed
FROM node:20-slim AS runner

# Install Chromium and every shared library it needs at runtime.
# Must run as root (default in this stage), BEFORE USER directive.
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Fail the build immediately if Chromium binary is missing or broken
RUN chromium --version

# Tell Playwright to use the system Chromium, skip its own download
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=0
ENV NODE_ENV=production

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled output and Prisma client from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy runtime config files
COPY package.json ./
COPY prisma ./prisma

# Create non-root user and transfer ownership AFTER all files are copied
RUN groupadd -r nestjs && useradd -r -g nestjs -u 1001 nestjs \
  && chown -R nestjs:nestjs /app

USER nestjs

EXPOSE 3000
CMD ["node", "dist/main"]
