import { Router } from 'express';
import { createAdminAuth } from './auth.js';
import { uploadBackup, presignGet } from '../s3/backup.js';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PhiStore } from '../phi/store.js';

export function createSnapshotRouter(deps: {
  secret: string;
  client: S3Client | null;
  bucket: string | undefined;
  tenantSlug: string;
  store: PhiStore;
}): Router {
  const router = Router();
  router.post('/admin/snapshot', createAdminAuth(deps.secret), async (_req, res, next) => {
    try {
      if (!deps.client || !deps.bucket) {
        return res.status(503).json({ error: 's3_not_configured' });
      }
      const meta = await uploadBackup(deps.client, deps.bucket, deps.tenantSlug, deps.store);
      const url = await presignGet(deps.client, deps.bucket, meta.key, 3600);
      res.json({ ...meta, downloadUrl: url });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
