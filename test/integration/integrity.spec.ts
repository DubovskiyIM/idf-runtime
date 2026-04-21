import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createPhiStore } from '../../src/phi/store.js';
import { checkIntegrity } from '../../src/domain/integrity.js';

describe('integrity check', () => {
  it('accepts Φ compatible with new ontology', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { title: 'hi' }, context: {} });

    const ontology = {
      entities: { Task: { fields: { title: { type: 'text' } } } },
      invariants: [],
    };
    const result = checkIntegrity(store, ontology);
    expect(result.ok).toBe(true);
    expect(result.rejectedEffects).toEqual([]);
  });

  it('flags existing rows that violate added required field', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { title: 'hi' }, context: {} });

    const ontology = {
      entities: {
        Task: {
          fields: {
            title: { type: 'text' },
            deadline: { type: 'date', required: true },
          },
        },
      },
      invariants: [],
    };
    const result = checkIntegrity(store, ontology);
    expect(result.ok).toBe(false);
    expect(result.rejectedEffects.length).toBeGreaterThan(0);
    expect(result.rejectedEffects[0].reason).toMatch(/required|missing/i);
  });

  it('flags removed entity', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: {}, context: {} });

    const result = checkIntegrity(store, { entities: {}, invariants: [] });
    expect(result.ok).toBe(false);
    expect(result.rejectedEffects[0].reason).toMatch(/unknown.*entity|removed/i);
  });
});
