import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createRevocationCache } from '../../src/viewer/revocation-cache.js';

describe('revocation cache', () => {
  it('inserts and looks up', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const cache = createRevocationCache(db);

    cache.upsert([
      { membershipId: 'm1', userId: 'u1', domainSlug: 'acme', revokedAt: '2026-04-21T10:00:00Z' },
    ]);

    expect(cache.isRevoked('u1', 'acme')).toBe(true);
    expect(cache.isRevoked('u1', 'other')).toBe(false);
    expect(cache.isRevoked('u2', 'acme')).toBe(false);
  });

  it('lastSyncedAt tracking', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const cache = createRevocationCache(db);
    expect(cache.lastSyncedAt()).toBeNull();
    cache.setSyncedAt(new Date('2026-04-21T11:00:00Z'));
    expect(cache.lastSyncedAt()).toEqual(new Date('2026-04-21T11:00:00Z'));
  });
});
