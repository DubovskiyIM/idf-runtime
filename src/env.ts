import { z } from 'zod';

const schema = z.object({
  TENANT_SLUG: z.string().regex(/^[a-z0-9-]+$/),
  DATA_DIR: z.string().default('/data'),
  PORT: z.coerce.number().default(3001),

  AUTH_JWKS_URL: z.string().url(),
  AUTH_REVOCATION_URL: z.string().url(),
  TENANT_HMAC_SECRET: z.string().min(32),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  BACKUP_ENABLED: z.coerce.boolean().default(false),
  REVOCATION_POLL_SECONDS: z.coerce.number().default(60),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'Invalid env: ' + parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
  }
  return parsed.data;
}
