import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PhiStore } from '../phi/store.js';

export type BackupMeta = { key: string; size: number; takenAt: Date };

export async function uploadBackup(
  client: S3Client,
  bucket: string,
  tenantSlug: string,
  store: PhiStore
): Promise<BackupMeta> {
  const takenAt = new Date();
  const effects = store.all();
  const jsonl = effects.map(e => JSON.stringify(e)).join('\n');
  const key = `tenants/${tenantSlug}/phi/${takenAt.toISOString().slice(0, 10)}/${takenAt.toISOString()}.jsonl`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: jsonl,
      ContentType: 'application/x-ndjson',
    })
  );

  return { key, size: jsonl.length, takenAt };
}

export async function presignGet(
  client: S3Client,
  bucket: string,
  key: string,
  ttlSeconds = 600
): Promise<string> {
  return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttlSeconds,
  });
}
