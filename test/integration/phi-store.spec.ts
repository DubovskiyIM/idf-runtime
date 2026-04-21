import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPhiStore } from '../../src/phi/store.js';
import { applyMigrations } from '../../src/phi/migrate.js';

describe('phi store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
  });

  it('appends effect and reads back', () => {
    const store = createPhiStore(db);
    const e = {
      alpha: 'create' as const,
      entity: 'Task',
      fields: { title: 'hi' },
      context: { actor: 'u1', intent: 'add_task' },
    };
    const inserted = store.append(e);
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.confirmedAt).toBeInstanceOf(Date);

    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0].fields).toEqual({ title: 'hi' });
  });

  it('appendRejected stores in separate table', () => {
    const store = createPhiStore(db);
    store.appendRejected({
      alpha: 'create',
      entity: 'X',
      fields: {},
      context: {},
      reason: 'role-capability',
      details: 'observer cannot create',
    });
    const rejected = store.rejected();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('role-capability');
  });

  it('filters audit by since', () => {
    const store = createPhiStore(db);
    const now = Date.now();
    store.append({ alpha: 'create', entity: 'A', fields: {}, context: {} });
    const since = new Date(now + 1000).toISOString();
    const filtered = store.audit({ since: new Date(since) });
    expect(filtered).toHaveLength(0);
    const all2 = store.audit({ since: new Date(now - 1000) });
    expect(all2.length).toBeGreaterThan(0);
  });
});
