import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createPhiStore } from '../../src/phi/store.js';
import { applyRenames } from '../../src/phi/renames.js';

describe('applyRenames', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
  });

  it('entity rename: UPDATE phi_effects SET entity = to', () => {
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't1', title: 'X' }, context: {} });
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't2', title: 'Y' }, context: {} });
    store.append({ alpha: 'create', entity: 'User', fields: { id: 'u1' }, context: {} });

    const r = applyRenames(db, [{ kind: 'entity', from: 'Task', to: 'Todo' }]);
    expect(r.applied).toBe(1);
    expect(r.effectsUpdated).toBe(2);

    const all = store.all();
    expect(all.filter((e) => e.entity === 'Todo')).toHaveLength(2);
    expect(all.filter((e) => e.entity === 'Task')).toHaveLength(0);
    expect(all.filter((e) => e.entity === 'User')).toHaveLength(1);
  });

  it('идемпотентно: повторный apply — no-op', () => {
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't1' }, context: {} });

    const r1 = applyRenames(db, [{ kind: 'entity', from: 'Task', to: 'Todo' }]);
    expect(r1.applied).toBe(1);

    const r2 = applyRenames(db, [{ kind: 'entity', from: 'Task', to: 'Todo' }]);
    expect(r2.applied).toBe(0);
    expect(r2.effectsUpdated).toBe(0);

    // Todo всё ещё есть (не повторно переименован)
    expect(store.all().filter((e) => e.entity === 'Todo')).toHaveLength(1);
  });

  it('field rename: json_set + json_remove на fields_json', () => {
    const store = createPhiStore(db);
    store.append({
      alpha: 'create',
      entity: 'Task',
      fields: { id: 't1', doneAt: '2026-01-01', title: 'X' },
      context: {},
    });
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't2', title: 'Y' }, context: {} });
    store.append({ alpha: 'create', entity: 'User', fields: { id: 'u1', doneAt: 'skip' }, context: {} });

    const r = applyRenames(db, [
      { kind: 'field', entity: 'Task', from: 'doneAt', to: 'completedAt' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.effectsUpdated).toBe(1); // только t1 имел doneAt

    const t1 = store.all().find((e) => e.fields.id === 't1');
    expect(t1?.fields.completedAt).toBe('2026-01-01');
    expect(t1?.fields).not.toHaveProperty('doneAt');

    // t2 не трогали
    const t2 = store.all().find((e) => e.fields.id === 't2');
    expect(t2?.fields).not.toHaveProperty('completedAt');

    // User.doneAt не трогали (другая entity)
    const u1 = store.all().find((e) => e.fields.id === 'u1');
    expect(u1?.fields.doneAt).toBe('skip');
  });

  it('пустой/undefined renames → no-op', () => {
    const r1 = applyRenames(db, []);
    const r2 = applyRenames(db, undefined);
    expect(r1.applied).toBe(0);
    expect(r2.applied).toBe(0);
  });
});
