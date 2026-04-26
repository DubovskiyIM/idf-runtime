import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createPhiStore } from '../../src/phi/store.js';
import { createRestoreRouter } from '../../src/admin/restore.js';

const SECRET = 'a'.repeat(64);
const BACKUP_TS = '2026-04-26T10-00-00-000Z';

describe('admin restore', () => {
  let app: express.Express;
  let dataDir: string;
  let store: ReturnType<typeof createPhiStore>;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });

    // Active phi.db с двумя effect'ами
    const phiPath = path.join(dataDir, 'phi.db');
    db = new Database(phiPath);
    applyMigrations(db);
    store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't1' }, context: {} });
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't2' }, context: {} });

    // Backup-каталог с phi.db (один effect)
    const backupDir = path.join(dataDir, 'backups', BACKUP_TS);
    fs.mkdirSync(backupDir);
    const backupDbPath = path.join(backupDir, 'phi.db');
    const backupDb = new Database(backupDbPath);
    applyMigrations(backupDb);
    const backupStore = createPhiStore(backupDb);
    backupStore.append({
      alpha: 'create',
      entity: 'Task',
      fields: { id: 'old' },
      context: {},
    });
    backupDb.close();

    app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf.toString('utf8');
        },
      }),
    );
    app.use(createRestoreRouter({ secret: SECRET, dataDir, store }));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function signed(method: 'POST', urlPath: string, bodyStr: string) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET)
      .update(`${method}\n${urlPath}\n${bodyStr}\n${ts}`)
      .digest('hex');
    return { ts, sig };
  }

  it('POST /admin/restore копирует backup поверх phi.db и reload\'ит store', async () => {
    expect(store.count()).toBe(2);
    const body = JSON.stringify({
      snapshotPath: path.join(dataDir, 'backups', BACKUP_TS),
    });
    const { ts, sig } = signed('POST', '/admin/restore', body);
    const res = await request(app)
      .post('/admin/restore')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restoredAt).toMatch(/^\d{4}-/);
    expect(store.count()).toBe(1);
  });

  it('400 на missing snapshotPath', async () => {
    const body = JSON.stringify({});
    const { ts, sig } = signed('POST', '/admin/restore', body);
    const res = await request(app)
      .post('/admin/restore')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('snapshot_path_required');
  });

  it('400 если snapshotPath outside dataDir/backups', async () => {
    const body = JSON.stringify({ snapshotPath: '/etc/passwd' });
    const { ts, sig } = signed('POST', '/admin/restore', body);
    const res = await request(app)
      .post('/admin/restore')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('snapshot_path_invalid');
  });

  it('400 если phi.db не существует в snapshot dir', async () => {
    const body = JSON.stringify({
      snapshotPath: path.join(dataDir, 'backups', 'nonexistent'),
    });
    const { ts, sig } = signed('POST', '/admin/restore', body);
    const res = await request(app)
      .post('/admin/restore')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('snapshot_not_found');
  });

  it('401 без HMAC signature', async () => {
    const res = await request(app)
      .post('/admin/restore')
      .set('Content-Type', 'application/json')
      .send({ snapshotPath: '/tmp' });
    expect(res.status).toBe(401);
  });
});
