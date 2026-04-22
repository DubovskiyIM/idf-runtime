import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST_REPO = process.env.HOST_REPO ?? join(process.env.HOME, 'WebstormProjects/idf');
const OUT = join(process.cwd(), 'static');

if (!existsSync(HOST_REPO)) {
  console.error(`Host repo not found at ${HOST_REPO}. Set HOST_REPO env var.`);
  process.exit(1);
}

// Host idf/dist/ часто root-owned (legacy sudo docker). Rsync в /tmp —
// обход без sudo: копируем исходники + node_modules reference'ом, build
// там, копируем dist оттуда в static/.
const TMP_COPY = '/tmp/idf-host-copy';
console.log('[build-frontend] rsync host в', TMP_COPY, '(обход root-owned dist/)');
execSync(
  `rsync -a --delete --exclude=dist --exclude='.git' --exclude='.worktrees' ${HOST_REPO}/ ${TMP_COPY}/`,
  { stdio: 'inherit' },
);
console.log('[build-frontend] building Vite в', TMP_COPY);
execSync('npm install --prefer-offline --no-audit', { cwd: TMP_COPY, stdio: 'inherit' });
execSync('npm run build', { cwd: TMP_COPY, stdio: 'inherit' });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(TMP_COPY, 'dist'), OUT, { recursive: true });

// Runtime tenants — single-domain deployments. Host-level studio entry (/studio.html)
// + ссылки на idf.intent-design.tech нерелевантны (это prototype surface для host
// idf-разработчика, не для PM tenant'а). Патчим post-copy:
//   1. rm studio.html — /studio.html → 404 от Express static middleware
//   2. sed "/studio.html" → "/" в JS бандлах (StudioRedirect fallback идёт на root,
//      кнопка «Открыть Studio →» в DomainRuntime ведёт на root)
//   3. sed "idf.intent-design.tech" → текущий hostname pattern (undefined route → "/")
const STUDIO_HTML = join(OUT, 'studio.html');
if (existsSync(STUDIO_HTML)) {
  rmSync(STUDIO_HTML);
  console.log('[build-frontend] removed studio.html');
}

const PATCHES = [
  { from: /\/studio\.html/g, to: '/' },
  { from: /https?:\/\/idf\.intent-design\.tech[^"'\s)]*/g, to: '/' },
];

function patchFileTree(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      patchFileTree(p);
      continue;
    }
    if (!/\.(js|mjs|html|css)$/.test(name)) continue;
    let content = readFileSync(p, 'utf8');
    let dirty = false;
    for (const { from, to } of PATCHES) {
      if (from.test(content)) {
        content = content.replace(from, to);
        dirty = true;
      }
    }
    if (dirty) {
      writeFileSync(p, content);
    }
  }
}

patchFileTree(OUT);
console.log(`[build-frontend] copied + patched → ${OUT}`);
