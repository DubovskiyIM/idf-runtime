import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const data = mkdtempSync(join(tmpdir(), 'idf-runtime-smoke-'));
execSync(`DATA_DIR=${data} node scripts/seed-domain.mjs`, { stdio: 'inherit' });

const server = spawn('node', ['--import=tsx', 'src/index.ts'], {
  env: {
    ...process.env,
    TENANT_SLUG: 'smoke',
    DATA_DIR: data,
    PORT: '3999',
    AUTH_JWKS_URL: 'http://127.0.0.1:1/jwks',
    AUTH_REVOCATION_URL: 'http://127.0.0.1:1/rev',
    TENANT_HMAC_SECRET: 'a'.repeat(64),
    BACKUP_ENABLED: 'false',
  },
  stdio: 'inherit',
});

await sleep(2500);

try {
  const h = await fetch('http://localhost:3999/health').then(r => r.json());
  if (h.status !== 'ok') throw new Error('health failed');
  console.log('✓ /health ok');

  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'a'.repeat(64)).update(`GET\n/admin/health\n\n${ts}`).digest('hex');
  const ah = await fetch('http://localhost:3999/admin/health', {
    headers: { 'x-idf-ts': String(ts), 'x-idf-sig': sig },
  }).then(r => r.json());
  console.log('✓ /admin/health:', ah);

  console.log('\n✓ SMOKE OK');
} catch (e) {
  console.error('✗ SMOKE FAILED', e);
  process.exitCode = 1;
} finally {
  server.kill();
}
