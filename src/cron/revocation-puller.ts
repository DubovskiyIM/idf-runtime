import cron from 'node-cron';
import type { RevocationCache } from '../viewer/revocation-cache.js';
import { logger } from '../logger.js';

export type PullerDeps = {
  cache: RevocationCache;
  revocationUrl: string;
  domainSlug: string;
  pollSeconds: number;
};

export function startRevocationPuller(deps: PullerDeps): { stop: () => void } {
  let intervalHandle: NodeJS.Timeout | null = null;
  let cronTask: ReturnType<typeof cron.schedule> | null = null;

  async function tick() {
    const since = deps.cache.lastSyncedAt() ?? new Date(0);
    const url = `${deps.revocationUrl}?since=${encodeURIComponent(since.toISOString())}&domainSlug=${encodeURIComponent(deps.domainSlug)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn({ status: res.status, url }, 'revocation pull failed');
        return;
      }
      const data = (await res.json()) as { revocations: Array<{ membershipId: string; userId: string; domainSlug: string; revokedAt: string }> };
      if (data.revocations?.length) {
        deps.cache.upsert(data.revocations);
        logger.info({ count: data.revocations.length }, 'revocation cache updated');
      }
      deps.cache.setSyncedAt(new Date());
    } catch (e) {
      logger.error({ err: e }, 'revocation pull error');
    }
  }

  if (deps.pollSeconds >= 60) {
    const expr = `*/${Math.max(1, Math.floor(deps.pollSeconds / 60))} * * * *`;
    cronTask = cron.schedule(expr, () => void tick());
  } else {
    intervalHandle = setInterval(() => void tick(), deps.pollSeconds * 1000);
  }

  return {
    stop() {
      cronTask?.stop();
      if (intervalHandle) clearInterval(intervalHandle);
    },
  };
}
