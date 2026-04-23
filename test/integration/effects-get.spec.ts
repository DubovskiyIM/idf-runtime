import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createPhiStore } from '../../src/phi/store.js';
import { applyMigrations } from '../../src/phi/migrate.js';
import { createEffectsRouter } from '../../src/routes/effects.js';

describe('GET /api/effects', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    store.append({
      alpha: 'create',
      entity: 'Lead',
      fields: { id: 'l-1', name: 'Acme' },
      context: { actor: 'user-1', intent: 'create_lead' },
    });
    store.append({
      alpha: 'create',
      entity: 'Deal',
      fields: { id: 'd-1', title: 't', amount: 1000 },
      context: { actor: 'user-1', intent: 'create_deal' },
    });

    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.viewer = { userId: 'user-1', role: 'owner', domainSlug: 'tenant' };
      next();
    });
    app.use(
      createEffectsRouter({
        store,
        getDomain: () => ({ roles: {}, entities: {} }),
        validate: () => ({ ok: true }),
      }),
    );
  });

  it('возвращает confirmed effects массивом под key "effects"', async () => {
    const res = await request(app).get('/api/effects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.effects)).toBe(true);
    expect(res.body.effects).toHaveLength(2);
    const entities = res.body.effects.map((e: { entity: string }) => e.entity).sort();
    expect(entities).toEqual(['Deal', 'Lead']);
  });

  it('требует viewer middleware (401 без viewer)', async () => {
    const emptyDb = new Database(':memory:');
    applyMigrations(emptyDb);
    const emptyStore = createPhiStore(emptyDb);
    const noViewerApp = express();
    noViewerApp.use(express.json());
    noViewerApp.use(
      createEffectsRouter({
        store: emptyStore,
        getDomain: () => ({ roles: {}, entities: {} }),
        validate: () => ({ ok: true }),
      }),
    );
    const res = await request(noViewerApp).get('/api/effects');
    expect(res.status).toBe(401);
  });

  it('POST + GET round-trip: записанный effect виден в GET response', async () => {
    const effect = {
      alpha: 'create',
      entity: 'Contact',
      fields: { id: 'c-1', fullName: 'Alice' },
    };
    const post = await request(app).post('/api/effects').send(effect);
    expect(post.status).toBe(200);
    const get = await request(app).get('/api/effects');
    expect(get.body.effects).toHaveLength(3);
    const contact = get.body.effects.find((e: { entity: string }) => e.entity === 'Contact');
    expect(contact.fields.fullName).toBe('Alice');
  });
});
