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
COPY tsconfig.json ./
COPY src ./src
# tsc only, без scripts/build-frontend.mjs (требует host repo, делается локально перед docker build)
RUN npx tsc

FROM base AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache wget
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY static ./static
# Tenant overview page (vanilla HTML/JS) — перекрывает host idf'овский
# index.html на '/' route. См. src/routes/tenant-index.ts.
COPY static-tenant-src/tenant-index.html ./static/tenant-index.html
COPY package.json ./
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "dist/index.js"]
