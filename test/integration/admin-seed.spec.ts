import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { createPhiStore, type PhiStore } from '../../src/phi/store.js';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createSeedRouter } from '../../src/admin/seed.js';

const SECRET = 'a'.repeat(64);

function sign(method: string, path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET)
    .update(`${method.toUpperCase()}\n${path}\n${body}\n${ts}`)
    .digest('hex');
  return { ts, sig };
}

describe('POST /admin/seed', () => {
  let db: Database.Database;
  let store: PhiStore;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    store = createPhiStore(db);
    app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf.toString('utf8');
        },
      }),
    );
    app.use(createSeedRouter({ store, secret: SECRET }));
  });

  it('инсертит effects с provided id', async () => {
    const body = {
      effects: [
        {
          id: 'lead-001',
          alpha: 'create',
          entity: 'Lead',
          fields: { id: 'lead-001', name: 'Acme', email: 'a@b.co' },
          context: { actor: 'seed' },
        },
      ],
    };
    const raw = JSON.stringify(body);
    const { ts, sig } = sign('POST', '/admin/seed', raw);
    const res = await request(app)
      .post('/admin/seed')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 1, total: 1 });

    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0].fields.name).toBe('Acme');
  });

  it('идемпотентно: повторный POST не дублирует', async () => {
    const body = {
      effects: [
        {
          id: 'lead-002',
          alpha: 'create',
          entity: 'Lead',
          fields: { id: 'lead-002', name: 'Globex' },
        },
      ],
    };
    const raw = JSON.stringify(body);

    const first = sign('POST', '/admin/seed', raw);
    await request(app)
      .post('/admin/seed')
      .set('x-idf-ts', String(first.ts))
      .set('x-idf-sig', first.sig)
      .set('content-type', 'application/json')
      .send(raw);

    const second = sign('POST', '/admin/seed', raw);
    const res2 = await request(app)
      .post('/admin/seed')
      .set('x-idf-ts', String(second.ts))
      .set('x-idf-sig', second.sig)
      .set('content-type', 'application/json')
      .send(raw);
    expect(res2.status).toBe(200);
    expect(res2.body.inserted).toBe(0);
    expect(res2.body.total).toBe(1);

    expect(store.count()).toBe(1);
  });

  it('без HMAC → 401', async () => {
    const res = await request(app)
      .post('/admin/seed')
      .send({ effects: [] });
    expect(res.status).toBe(401);
  });

  it('empty effects array → 400', async () => {
    const body = { effects: [] };
    const raw = JSON.stringify(body);
    const { ts, sig } = sign('POST', '/admin/seed', raw);
    const res = await request(app)
      .post('/admin/seed')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(400);
  });

  it('invalid effect shape → 400', async () => {
    const body = { effects: [{ id: 'x', alpha: 'nope', entity: 'E', fields: {} }] };
    const raw = JSON.stringify(body);
    const { ts, sig } = sign('POST', '/admin/seed', raw);
    const res = await request(app)
      .post('/admin/seed')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(400);
  });

  it('bulk 100 effects — все инсертятся в одной транзакции', async () => {
    const effects = Array.from({ length: 100 }, (_, i) => ({
      id: `bulk-${i}`,
      alpha: 'create' as const,
      entity: 'Item',
      fields: { id: `bulk-${i}`, n: i },
    }));
    const raw = JSON.stringify({ effects });
    const { ts, sig } = sign('POST', '/admin/seed', raw);
    const res = await request(app)
      .post('/admin/seed')
      .set('x-idf-ts', String(ts))
      .set('x-idf-sig', sig)
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(100);
    expect(store.count()).toBe(100);
  });
});
