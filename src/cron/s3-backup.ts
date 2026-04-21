import cron from 'node-cron';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PhiStore } from '../phi/store.js';
import { uploadBackup } from '../s3/backup.js';
import { logger } from '../logger.js';

export function startBackupCron(deps: {
  client: S3Client;
  bucket: string;
  tenantSlug: string;
  store: PhiStore;
}) {
  const task = cron.schedule('7 * * * *', async () => {
    try {
      const meta = await uploadBackup(deps.client, deps.bucket, deps.tenantSlug, deps.store);
      logger.info({ key: meta.key, size: meta.size }, 'Φ backup uploaded');
    } catch (e) {
      logger.error({ err: e }, 'backup failed');
    }
  });
  return { stop: () => task.stop() };
}
