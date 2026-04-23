import express from 'express';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { loadEnv } from './env.js';
import { logger } from './logger.js';
import { applyMigrations } from './phi/migrate.js';
import { applyRenames } from './phi/renames.js';
import { createPhiStore } from './phi/store.js';
import { readDomain } from './domain/loader.js';
import { createRevocationCache } from './viewer/revocation-cache.js';
import { startRevocationPuller } from './cron/revocation-puller.js';
import { createJwtVerifier } from './viewer/jwt.js';
import { createViewerMiddleware } from './viewer/middleware.js';
import { createReloadRouter } from './admin/reload.js';
import { createAuditRouter } from './admin/audit.js';
import { createAdminHealthRouter } from './admin/health.js';
import { createSnapshotRouter } from './admin/snapshot.js';
import { createSeedRouter } from './admin/seed.js';
import { createS3Client } from './s3/client.js';
import { startBackupCron } from './cron/s3-backup.js';
import { createVoiceRouter } from './routes/voice.js';
import { createDocumentRouter } from './routes/document.js';
import { createAgentRouter } from './routes/agent.js';
import { createEffectsRouter } from './routes/effects.js';
import { createTenantIndexRouter } from './routes/tenant-index.js';
import { makeValidator } from './validator.js';

const env = loadEnv();
const db = new Database(join(env.DATA_DIR, 'phi.db'));
applyMigrations(db);
const store = createPhiStore(db);

let currentDomain: any =
  readDomain(env.DATA_DIR)?.json ?? { entities: {}, intents: {}, roles: {}, projections: {} };

// Apply domain.renames к phi.db (UPDATE entity / fields_json). Идемпотентно
// через applied_renames tracking — повторный startup с тем же списком
// renames no-op. Новые entries из деплоев — применятся только раз.
{
  const result = applyRenames(db, currentDomain.renames);
  if (result.applied > 0) {
    logger.info(
      { appliedRenames: result.applied, effectsUpdated: result.effectsUpdated },
      'renames applied on startup',
    );
  }
}

const revCache = createRevocationCache(db);
startRevocationPuller({
  cache: revCache,
  revocationUrl: env.AUTH_REVOCATION_URL,
  domainSlug: env.TENANT_SLUG,
  pollSeconds: env.REVOCATION_POLL_SECONDS,
});

const verify = createJwtVerifier(env.AUTH_JWKS_URL);

const s3 = createS3Client(env);
if (env.BACKUP_ENABLED && s3 && env.S3_BUCKET) {
  startBackupCron({
    client: s3,
    bucket: env.S3_BUCKET,
    tenantSlug: env.TENANT_SLUG,
    store,
  });
}

const app = express();
app.use(pinoHttp({ logger }));
app.use(cookieParser());
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
// Tenant `/` — overview page с inline domain-JSON. Перехватывает root ДО
// express.static чтобы обойти host idf bundle (он умеет только 14 pre-built
// доменов, не рендерит arbitrary user-created ontology).
app.use(
  createTenantIndexRouter({
    getDomain: () => currentDomain,
    tenantSlug: env.TENANT_SLUG,
  }),
);
app.use(express.static('static'));

// admin — HMAC-gated, не через viewer middleware
app.use(
  createReloadRouter({
    dataDir: env.DATA_DIR,
    secret: env.TENANT_HMAC_SECRET,
    store,
    onAccept: (d) => {
      currentDomain = d;
      const r = applyRenames(db, d.renames);
      if (r.applied > 0) {
        logger.info(
          { appliedRenames: r.applied, effectsUpdated: r.effectsUpdated },
          'renames applied on reload',
        );
      }
    },
  })
);
app.use(createAuditRouter({ store, secret: env.TENANT_HMAC_SECRET }));
app.use(createSeedRouter({ store, secret: env.TENANT_HMAC_SECRET }));
app.use(createAdminHealthRouter({ store, secret: env.TENANT_HMAC_SECRET }));
app.use(
  createSnapshotRouter({
    secret: env.TENANT_HMAC_SECRET,
    client: s3,
    bucket: env.S3_BUCKET,
    tenantSlug: env.TENANT_SLUG,
    store,
  })
);

// viewer routes — JWT + revocation через middleware
const viewerMw = createViewerMiddleware(verify, env.TENANT_SLUG, (uid, slug) =>
  revCache.isRevoked(uid, slug)
);
const withViewer = express.Router();
withViewer.use(viewerMw);

const getWorld = (_viewer: any) => {
  const effects = store.all();
  const world: Record<string, Record<string, any>> = {};
  for (const e of effects) {
    const id = (e.fields as any)?.id as string | undefined;
    if (!id) continue;
    if (!world[e.entity]) world[e.entity] = {};
    if (e.alpha === 'create') {
      world[e.entity][id] = { ...e.fields };
    } else if (e.alpha === 'replace') {
      world[e.entity][id] = { ...(world[e.entity][id] ?? {}), ...e.fields };
    } else if (e.alpha === 'remove') {
      delete world[e.entity][id];
    }
  }
  return world;
};

withViewer.use(createVoiceRouter({ getDomain: () => currentDomain, getWorld }));
withViewer.use(createDocumentRouter({ getDomain: () => currentDomain, getWorld }));
withViewer.use(createAgentRouter({ getDomain: () => currentDomain, getWorld }));
withViewer.use(
  createEffectsRouter({
    store,
    getDomain: () => currentDomain,
    validate: makeValidator(),
  })
);
app.use(withViewer);

app.listen(env.PORT, () => {
  logger.info({ tenant: env.TENANT_SLUG, port: env.PORT }, 'runtime started');
});
