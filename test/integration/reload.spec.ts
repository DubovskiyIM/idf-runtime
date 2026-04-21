import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createPhiStore } from '../../src/phi/store.js';
import { createReloadRouter } from '../../src/admin/reload.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'a'.repeat(64);

describe('POST /admin/reload', () => {
  let app: express.Express;
  let dataDir: string;
  let db: Database.Database;
  let ontologyRef: { current: any };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'idf-runtime-test-'));
    db = new Database(':memory:');
    applyMigrations(db);
    ontologyRef = { current: null };
    app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
    app.use(
      createReloadRouter({
        dataDir,
        secret: SECRET,
        store: createPhiStore(db),
        onAccept: (ontology) => { ontologyRef.current = ontology; },
      })
    );
  });

  function signed(body: any, path = '/admin/reload') {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET).update(`POST\n${path}\n${raw}\n${ts}`).digest('hex');
    return { raw, ts, sig };
  }

  it('accepts signed domain.json, writes to disk, calls onAccept', async () => {
    const domain = {
      __version: 'v1',
      entities: { Task: { fields: { title: { type: 'text' } } } },
      intents: {},
      invariants: [],
    };
    const { raw, ts, sig } = signed(domain);

    const res = await request(app)
      .post('/admin/reload')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('content-type', 'application/json')
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ontologyRef.current.entities.Task).toBeDefined();
  });

  it('rejects if integrity check fails', async () => {
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { title: 'hi' }, context: {} });

    const domain = { __version: 'v2', entities: {}, intents: {}, invariants: [] };
    const { raw, ts, sig } = signed(domain);

    const res = await request(app)
      .post('/admin/reload')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('content-type', 'application/json')
      .send(raw);

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.rejectedEffects.length).toBeGreaterThan(0);
    expect(ontologyRef.current).toBeNull();
  });

  it('rejects bad signature', async () => {
    const res = await request(app)
      .post('/admin/reload')
      .set('x-idf-ts', String(Math.floor(Date.now() / 1000)))
      .set('x-idf-sig', 'deadbeef')
      .set('content-type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
  });
});
