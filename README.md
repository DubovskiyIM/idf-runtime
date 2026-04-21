# idf-runtime

Data plane image для IDF SaaS — один container на домен. Содержит host-runtime (Express + SQLite + Φ append-only) + admin-слой (hot-reload ontology, audit, snapshot, revocation pull).

## Responsibilities

- **Φ store** — SQLite append-only log эффектов + fold в world.
- **Viewer JWT** — verify через `auth.intent-design.tech/.well-known/jwks.json` (remote JWKs с кэшем).
- **Admin API** — `POST /admin/reload` (HMAC-signed domain.json), `GET /admin/audit|rejected|snapshot`.
- **Materializations (§1 × 4)** — pixel (static SPA bundle), voice, document, agent — thin wrappers над SDK.
- **Revocation puller** — каждые 60с `GET auth/revocations` → обновить local cache.
- **S3 backup** — каждый час JSONL stream Φ → signed URL в `/admin/snapshot`.

## Local dev

```bash
npm install
npm run seed              # положить test domain.json в data/
npm run dev
```

## Deploy

Один image `idf-runtime:dev` серваит один tenant. Control plane (`studio.idf.dev`) оркеструет создание instance'ов (на VPS — добавляет в `docker-compose.yml` на 132.243.17.177).
