FROM node:22-alpine AS base
WORKDIR /app
# better-sqlite3 native build
RUN apk add --no-cache python3 make g++

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS builder
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
# Build server (tsc) + tenant frontend (vite). Static/index.html + assets/
# создаются vite'ом — не нужен локальный pre-build (в отличие от старой
# scripts/build-frontend.mjs которая rsync'ила host idf).
RUN npx tsc && npx vite build

FROM base AS runtime
ENV NODE_ENV=production
# DNS resolve order: IPv4 первым. На VPS api.anthropic.com резолвится в IPv6
# первым (Node 17+ default = 'verbatim'), и Claude CLI шлёт запросы напрямую
# по IPv6, минуя Xray HTTPS proxy (bindится только на IPv4 0.0.0.0:10809).
# Форсируем IPv4-first чтобы proxy-fallback работал и для Node native fetch,
# и для CLI дочерних процессов. Identical с idf-studio Dockerfile.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# tini — init как PID 1: reap'ает зомби-детей от Claude CLI subprocess'ов.
# git + ripgrep — минимизируют warnings от claude CLI startup (реальные
# tool-calls заблокированы --disallowed-tools='*').
RUN apk add --no-cache tini wget git ripgrep
# Claude CLI для /api/agent/:slug/console/turn (tool-use loop через subprocess).
# OAuth credentials монтируются снаружи: /root/.claude:ro + /root/.claude.json:ro
# (per-tenant docker-compose.yml). Identical pattern с idf-studio.
RUN npm install -g @anthropic-ai/claude-code
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/static ./static
COPY package.json ./
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3001/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
