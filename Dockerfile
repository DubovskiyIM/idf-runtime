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
RUN apk add --no-cache wget
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/static ./static
COPY package.json ./
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "dist/index.js"]
