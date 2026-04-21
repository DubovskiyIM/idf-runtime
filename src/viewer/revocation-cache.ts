import type Database from 'better-sqlite3';

export type RevocationEntry = {
  membershipId: string;
  userId: string;
  domainSlug: string;
  revokedAt: string;
};

export type RevocationCache = {
  upsert(entries: RevocationEntry[]): void;
  isRevoked(userId: string, domainSlug: string): boolean;
  lastSyncedAt(): Date | null;
  setSyncedAt(at: Date): void;
};

export function createRevocationCache(db: Database.Database): RevocationCache {
  const upsertStmt = db.prepare(`
    INSERT INTO revocation_cache(membership_id, user_id, domain_slug, revoked_at)
    VALUES(@membershipId, @userId, @domainSlug, @revokedAt)
    ON CONFLICT(membership_id) DO UPDATE SET revoked_at = excluded.revoked_at
  `);
  const check = db.prepare(
    'SELECT 1 FROM revocation_cache WHERE user_id = ? AND domain_slug = ? LIMIT 1'
  );
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  return {
    upsert(entries) {
      const tx = db.transaction((items: RevocationEntry[]) => {
        for (const e of items) upsertStmt.run(e);
      });
      tx(entries);
    },
    isRevoked(userId, domainSlug) {
      return !!check.get(userId, domainSlug);
    },
    lastSyncedAt() {
      const row = getMeta.get('revocation_last_synced_at') as { value: string } | undefined;
      return row ? new Date(row.value) : null;
    },
    setSyncedAt(at) {
      setMeta.run('revocation_last_synced_at', at.toISOString());
    },
  };
}
