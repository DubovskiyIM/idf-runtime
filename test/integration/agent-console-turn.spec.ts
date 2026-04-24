import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createPhiStore } from '../../src/phi/store';
import { applyMigrations } from '../../src/phi/migrate';
import { createAgentRouter } from '../../src/routes/agent';

const minimalDomain: any = {
  roles: {
    agent: {
      canExecute: ['buy_asset'],
      preapproval: {
        entity: 'AgentPreapproval',
        ownerField: 'userId',
        requiredFor: [],
        checks: [],
      },
    },
  },
  intents: {
    buy_asset: {
      id: 'buy_asset',
      forRoles: ['agent'],
      parameters: { total: { type: 'number' } },
      particles: {
        effects: [
          {
            entity: 'Transaction',
            alpha: 'create',
            value: { id: '{{auto}}', total: '{{params.total}}', userId: '{{viewer.id}}' },
          },
        ],
      },
    },
  },
  entities: {},
  invariants: [],
  rules: [],
};

function buildApp(store: any, mockRunner: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.viewer = { id: 'u-1', role: 'agent' };
    next();
  });
  const getWorld = () => ({});
  app.use(
    createAgentRouter({
      getDomain: () => minimalDomain,
      getWorld,
      getStore: () => store,
      runToolUseLoop: mockRunner,
    }),
  );
  return app;
}

describe('POST /api/agent/:slug/console/turn', () => {
  it('streams SSE events from mock runner', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);

    const mockRunner = async (opts: any) => {
      opts.onEvent({ kind: 'thinking', text: 'думаю' });
      const result = await opts.tools.exec_intent({
        intentId: 'buy_asset',
        params: { total: 100 },
      });
      opts.onEvent({ kind: 'effect', result });
      opts.onEvent({ kind: 'done', totalCalls: 1 });
    };

    const app = buildApp(store, mockRunner);
    const res = await request(app)
      .post('/api/agent/invest/console/turn')
      .send({ task: 'hello' })
      .buffer(true)
      .parse((response, cb) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (c: string) => (data += c));
        response.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    const text = String(res.body ?? res.text ?? '');
    expect(text).toContain('"kind":"thinking"');
    expect(text).toContain('"kind":"effect"');
    expect(text).toContain('"kind":"done"');
    expect(text).toContain('"ok":true');

    const transactions = store.all().filter((e: any) => e.entity === 'Transaction');
    expect(transactions).toHaveLength(1);
  });

  it('returns 400 without task', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    const app = buildApp(store, async () => {});
    const res = await request(app).post('/api/agent/invest/console/turn').send({});
    expect(res.status).toBe(400);
  });

  it('returns 401 without viewer', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = createPhiStore(db);
    const app = express();
    app.use(express.json());
    app.use(
      createAgentRouter({
        getDomain: () => minimalDomain,
        getWorld: () => ({}),
        getStore: () => store,
        runToolUseLoop: (async () => {}) as any,
      }),
    );
    const res = await request(app)
      .post('/api/agent/invest/console/turn')
      .send({ task: 't' });
    expect(res.status).toBe(401);
  });
});
