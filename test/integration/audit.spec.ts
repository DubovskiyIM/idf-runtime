import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createPhiStore } from '../../src/phi/store.js';
import { createAuditRouter } from '../../src/admin/audit.js';

const SECRET = 'a'.repeat(64);

describe('admin audit', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    store.append({ alpha: 'create', entity: 'Task', fields: { id: 't1' }, context: { actor: 'u1' } });
    store.append({ alpha: 'replace', entity: 'Task', fields: { id: 't1', done: true }, context: { actor: 'u1' } });
    store.appendRejected({
      alpha: 'remove',
      entity: 'Task',
      fields: { id: 't1' },
      context: { actor: 'u2' },
      reason: 'role-capability',
    });

    app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
    app.use(createAuditRouter({ store, secret: SECRET }));
  });

  function signed(path: string) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET).update(`GET\n${path}\n\n${ts}`).digest('hex');
    return { ts, sig };
  }

  it('GET /admin/audit returns all confirmed effects', async () => {
    const { ts, sig } = signed('/admin/audit');
    const res = await request(app)
      .get('/admin/audit')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig);
    expect(res.status).toBe(200);
    expect(res.body.effects).toHaveLength(2);
  });

  it('GET /admin/audit?entity=Task filters', async () => {
    const { ts, sig } = signed('/admin/audit?entity=Task');
    const res = await request(app)
      .get('/admin/audit?entity=Task')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig);
    expect(res.body.effects).toHaveLength(2);
  });

  it('GET /admin/audit?role=editor filters by context.viewerRole', async () => {
    // Дополнительные seed'ы с явной viewerRole — beforeEach уже добавил 2 без role.
    const store = createPhiStore(db);
    store.append({
      alpha: 'create',
      entity: 'Doc',
      fields: { id: 'd1' },
      context: { actor: 'u1', viewerRole: 'editor' },
    });
    store.append({
      alpha: 'create',
      entity: 'Doc',
      fields: { id: 'd2' },
      context: { actor: 'u1', viewerRole: 'viewer' },
    });
    store.append({
      alpha: 'create',
      entity: 'Doc',
      fields: { id: 'd3' },
      context: { actor: 'u2', actorRole: 'editor' },
    });

    const path = '/admin/audit?role=editor';
    const { ts, sig } = signed(path);
    const res = await request(app)
      .get(path)
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig);
    expect(res.status).toBe(200);
    // 2 матча: один по viewerRole=editor (d1), один по actorRole=editor (d3).
    expect(res.body.effects).toHaveLength(2);
    const ids = res.body.effects.map((e: any) => e.fields.id).sort();
    expect(ids).toEqual(['d1', 'd3']);
  });

  it('GET /admin/audit?until=<iso> filters by confirmedAt < until', async () => {
    // Все записи из beforeEach созданы только что — until в будущем включает всё,
    // until в прошлом — ничего.
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    const futurePath = `/admin/audit?until=${encodeURIComponent(future)}`;
    const futureSigned = signed(futurePath);
    const futureRes = await request(app)
      .get(futurePath)
      .set('x-idf-ts', String(futureSigned.ts))
      .set('x-idf-sig', futureSigned.sig);
    expect(futureRes.status).toBe(200);
    expect(futureRes.body.effects).toHaveLength(2);

    const pastPath = `/admin/audit?until=${encodeURIComponent(past)}`;
    const pastSigned = signed(pastPath);
    const pastRes = await request(app)
      .get(pastPath)
      .set('x-idf-ts', String(pastSigned.ts))
      .set('x-idf-sig', pastSigned.sig);
    expect(pastRes.status).toBe(200);
    expect(pastRes.body.effects).toHaveLength(0);
  });

  it('GET /admin/rejected returns rejected effects', async () => {
    const { ts, sig } = signed('/admin/rejected');
    const res = await request(app)
      .get('/admin/rejected')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].reason).toBe('role-capability');
  });
});
