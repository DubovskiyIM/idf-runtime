# VPS Deployment runbook — idf-runtime

**Target:** 132.243.17.177 (Ubuntu 24.04 LTS), один контейнер = один домен. Nginx reverse-proxy + certbot управляется снаружи (как `auth.intent-design.tech`), новый tenant добавляется в `docker-compose.yml` в `/opt/idf-runtime/<slug>/`.

## Pre-requisites

- `/opt/idf-auth/` уже развёрнут (identity plane) — `auth.intent-design.tech`
- VPS имеет Docker + docker compose + nginx + certbot
- `TENANT_HMAC_SECRET` — один общий secret между identity plane, data plane, control plane. Хранится в `.env` на VPS.

## First deploy (one tenant)

Пример для tenant `demo` → `demo.app.intent-design.tech`.

### 1. Собрать frontend и image локально

```bash
cd ~/WebstormProjects/idf-runtime
# clean host dist (может требовать sudo если остались root-owned артефакты)
rm -rf ~/WebstormProjects/idf/dist
HOST_REPO=~/WebstormProjects/idf node scripts/build-frontend.mjs

# amd64 build (Mac M1 → VPS amd64)
docker buildx build --platform linux/amd64 -t idf-runtime:amd64 --load .
docker save idf-runtime:amd64 -o /tmp/idf-runtime-amd64.tar
```

### 2. Создать tenant directory на VPS

```bash
ssh root@132.243.17.177 'mkdir -p /opt/idf-runtime/demo/data'
scp /tmp/idf-runtime-amd64.tar root@132.243.17.177:/opt/idf-runtime/
ssh root@132.243.17.177 '
  docker load -i /opt/idf-runtime/idf-runtime-amd64.tar
  docker tag idf-runtime:amd64 idf-runtime:dev
'
```

### 3. Seed initial domain.json

```bash
# локально
DATA_DIR=/tmp/idf-demo-data node scripts/seed-domain.mjs
scp /tmp/idf-demo-data/domain.json root@132.243.17.177:/opt/idf-runtime/demo/data/
```

### 4. Создать `/opt/idf-runtime/demo/docker-compose.yml`

```yaml
services:
  runtime:
    image: idf-runtime:dev
    container_name: idf-runtime-demo
    restart: unless-stopped
    environment:
      TENANT_SLUG: demo
      DATA_DIR: /data
      PORT: "3001"
      AUTH_JWKS_URL: https://auth.intent-design.tech/.well-known/jwks.json
      AUTH_REVOCATION_URL: https://auth.intent-design.tech/revocations
      TENANT_HMAC_SECRET: ${TENANT_HMAC_SECRET}
      BACKUP_ENABLED: "false"
      NODE_ENV: production
      REVOCATION_POLL_SECONDS: "60"
    volumes:
      - ./data:/data
    ports:
      - "127.0.0.1:4001:3001"  # per-tenant mapping: demo → 4001, next → 4002, etc.
```

`.env` рядом:
```
TENANT_HMAC_SECRET=<тот же что в /opt/idf-auth/.env>
```

### 5. Nginx site `/etc/nginx/sites-available/demo.app.intent-design.tech`

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name demo.app.intent-design.tech;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { proxy_pass http://127.0.0.1:4001; }
}
```

Certbot:
```bash
ssh root@132.243.17.177 '
  ln -sf /etc/nginx/sites-available/demo.app.intent-design.tech /etc/nginx/sites-enabled/
  nginx -t && nginx -s reload
  certbot --nginx -d demo.app.intent-design.tech --non-interactive --agree-tos -m dubovskiy.im@gmail.com --redirect
'
```

### 6. Launch

```bash
ssh root@132.243.17.177 'cd /opt/idf-runtime/demo && docker compose up -d'
sleep 3
curl https://demo.app.intent-design.tech/health
```

Expected: `{"status":"ok"}`.

## Multi-tenant (future — автоматизирует control plane)

Control plane (`studio.intent-design.tech`) при клике «Deploy»:
1. `mkdir /opt/idf-runtime/<slug>`
2. Генерирует compose из template (порт 4000 + N)
3. `scp domain.json` → data-directory
4. `nginx reload + certbot`
5. `docker compose up -d`

Этот runbook — для manual первого tenant'а до Plan 3.

## Admin reload

```bash
# подписать domain.json + POST
TS=$(date +%s)
BODY=$(cat new-domain.json | jq -c .)
SIG=$(echo -n "POST\n/admin/reload\n$BODY\n$TS" | openssl dgst -sha256 -hmac "$TENANT_HMAC_SECRET" -r | cut -d' ' -f1)
curl -X POST https://demo.app.intent-design.tech/admin/reload \
  -H "x-idf-ts: $TS" \
  -H "x-idf-sig: $SIG" \
  -H "content-type: application/json" \
  --data "$BODY"
```

Ответы:
- `200 {ok: true}` — ontology применена
- `409 {ok: false, rejectedEffects: [...]}` — integrity check fail, старая ontology остаётся
- `401` — signature / timestamp invalid

## Troubleshooting

- **Container restart-loop**: `docker compose logs runtime --tail=30`. Частое — arch mismatch (arm64 vs amd64) → пересобрать с `--platform linux/amd64`.
- **401 на viewer endpoints**: JWKs URL недоступен (проверить `curl https://auth.intent-design.tech/.well-known/jwks.json`), или JWT issuer mismatch (runtime ожидает `auth.idf.dev` как issuer, matches identity plane).
- **409 на /admin/reload**: integrity check отверг часть эффектов. Посмотреть `res.body.rejectedEffects` — показывает effectId + reason + details.
- **Volume `/data` empty после restart**: docker volume не примонтирован — проверь `volumes:` в compose.
