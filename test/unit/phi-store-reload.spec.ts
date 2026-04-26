import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createPhiStore } from '../../src/phi/store.js';

describe('PhiStore reload', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('после reload видит rows из подменённого SQLite-файла', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-reload-'));
    cleanups.push(dir);
    const dbPath = path.join(dir, 'phi.db');

    const db1 = new Database(dbPath);
    applyMigrations(db1);
    const store = createPhiStore(db1);
    store.append({ alpha: 'create', entity: 'Task', fields: { id: '1' }, context: {} });
    expect(store.count()).toBe(1);
    db1.close();

    // Создаём «backup» — новый файл с пустой phi-таблицей и копируем поверх
    const altPath = path.join(dir, 'alt.db');
    const altDb = new Database(altPath);
    applyMigrations(altDb);
    altDb.close();
    fs.copyFileSync(altPath, dbPath);

    // Reload: store должен увидеть пустую базу
    const db2 = new Database(dbPath);
    applyMigrations(db2);
    store.reload(db2);
    expect(store.count()).toBe(0);

    db2.close();
  });

  it('после reload prepared statements работают на новом handle (append + count)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-reload-stmt-'));
    cleanups.push(dir);
    const dbPath = path.join(dir, 'phi.db');

    const db1 = new Database(dbPath);
    applyMigrations(db1);
    const store = createPhiStore(db1);
    db1.close();

    // Открываем новый handle и reload'им — старый закрыт, append на старых
    // prepared statements бы упал. После reload — должен работать.
    const db2 = new Database(dbPath);
    applyMigrations(db2);
    store.reload(db2);

    expect(() =>
      store.append({ alpha: 'create', entity: 'Task', fields: { id: 'x' }, context: {} }),
    ).not.toThrow();
    expect(store.count()).toBe(1);

    db2.close();
  });
});
