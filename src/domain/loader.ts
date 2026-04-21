import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type DomainBundle = {
  json: any;
  raw: string;
  version: string;
};

export function readDomain(dataDir: string): DomainBundle | null {
  const path = join(dataDir, 'domain.json');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const json = JSON.parse(raw);
  return { json, raw, version: json.__version ?? 'unknown' };
}

export function writeDomain(dataDir: string, raw: string): void {
  const path = join(dataDir, 'domain.json');
  const tmp = path + '.tmp';
  writeFileSync(tmp, raw, 'utf8');
  renameSync(tmp, path);
}
