import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const HOST_REPO = process.env.HOST_REPO ?? join(process.env.HOME, 'WebstormProjects/idf');
const OUT = join(process.cwd(), 'static');

if (!existsSync(HOST_REPO)) {
  console.error(`Host repo not found at ${HOST_REPO}. Set HOST_REPO env var.`);
  process.exit(1);
}

console.log('[build-frontend] building Vite в', HOST_REPO);
execSync('npm run build', { cwd: HOST_REPO, stdio: 'inherit' });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(HOST_REPO, 'dist'), OUT, { recursive: true });

console.log(`[build-frontend] copied → ${OUT}`);
