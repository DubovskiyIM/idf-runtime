import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createPhiStore } from '../../src/phi/store';
import { applyMigrations } from '../../src/phi/migrate';
import { createAgentRouter } from '../../src/routes/agent';

const minimalDomain: any = {
  roles: {
    agent: {
      base: 'agent',
      canExecute: ['buy_asset'],
      preapproval: {
        entity: 'AgentPreapproval',
        ownerField: 'userId',
        requiredFor: ['buy_asset'],
        checks: [
          { kind: 'active', field: 'active' },
          { kind: 'maxAmount', paramField: 'total', limitField: 'maxOrderAmount' },
          { kind: 'csvInclude', paramField: 'assetType', limitField: 'allowedAssetTypes' },
        ],
      },
    },
  },
  intents: {
    buy_asset: {
      id: 'buy_asset',
      forRoles: ['agent'],
      parameters: {
        assetId: { type: 'string' },
        assetType: { type: 'string' },
        total: { type: 'number' },
      },
      particles: {
        effects: [
          {
            entity: 'Transaction',
            alpha: 'create',
            value: {
              id: '{{auto}}',
              assetId: '{{params.assetId}}',
              assetType: '{{params.assetType}}',
              total: '{{params.total}}',
              userId: '{{viewer.id}}',
            },
          },
        ],
      },
    },
  },
  entities: {
    Transaction: {
      id: 'Transaction',
      fields: {
        id: { type: 'id' },
        assetId: { type: 'string' },
        assetType: { type: 'string' },
        total: { type: 'number' },
        userId: { type: 'string' },
      },
    },
    AgentPreapproval: {
      id: 'AgentPreapproval',
      fields: {
        id: { type: 'id' },
        userId: { type: 'string' },
        active: { type: 'boolean' },
        maxOrderAmount: { type: 'number' },
        allowedAssetTypes: { type: 'string' },
      },
    },
  },
  invariants: [],
  rules: [],
};

function buildApp(store: any, domain: any = minimalDomain) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.viewer = { id: 'u-1', role: 'agent' };
    next();
  });

  const getWorld = () => {
    const effects = store.all();
    const world: Record<string, Record<string, any>> = {};
    for (const e of effects) {
      const id = e.fields?.id;
      if (!id) continue;
      if (!world[e.entity]) world[e.entity] = {};
      if (e.alpha === 'create') world[e.entity][id] = { ...e.fields };
      else if (e.alpha === 'replace') world[e.entity][id] = { ...(world[e.entity][id] ?? {}), ...e.fields };
      else if (e.alpha === 'remove') delete world[e.entity][id];
    }
    return world;
  };

  app.use(
    createAgentRouter({
      getDomain: () => domain,
      getWorld,
      getStore: () => store,
    }),
  );
  return app;
}

function seedPreapproval(store: any) {
  store.append({
    alpha: 'create',
    entity: 'AgentPreapproval',
    fields: {
      id: 'pa-1',
      userId: 'u-1',
      active: true,
      maxOrderAmount: 10000,
      allowedAssetTypes: 'stock,bond,etf',
    },
    context: {},
  });
}

describe('POST /api/agent/:slug/exec', () => {
  let db: Database.Database;
  let store: any;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    store = createPhiStore(db);
    seedPreapproval(store);
  });

  it('accepts valid preapproved order', async () => {
    const res = await request(buildApp(store))
      .post('/api/agent/invest/exec')
      .send({ intentId: 'buy_asset', params: { assetId: 'a-1', assetType: 'stock', total: 5000 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.effectIds).toHaveLength(1);
    const confirmed = store.all().filter((e: any) => e.entity === 'Transaction');
    expect(confirmed).toHaveLength(1);
  });

  it('rejects when total exceeds maxAmount', async () => {
    const res = await request(buildApp(store))
      .post('/api/agent/invest/exec')
      .send({ intentId: 'buy_asset', params: { assetId: 'a-1', assetType: 'stock', total: 50000 } });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('preapproval_denied');
    expect(res.body.failedCheck).toBe('maxAmount');
    const confirmed = store.all().filter((e: any) => e.entity === 'Transaction');
    expect(confirmed).toHaveLength(0);
  });

  it('rejects disallowed assetType (csvInclude)', async () => {
    const res = await request(buildApp(store))
      .post('/api/agent/invest/exec')
      .send({ intentId: 'buy_asset', params: { assetId: 'a-1', assetType: 'crypto', total: 1000 } });
    expect(res.status).toBe(403);
    expect(res.body.failedCheck).toBe('csvInclude');
  });

  it('rejects intent not in canExecute', async () => {
    const res = await request(buildApp(store))
      .post('/api/agent/invest/exec')
      .send({ intentId: 'sell_asset', params: {} });
    expect(res.status).toBe(405);
  });

  it('returns 401 без viewer', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createAgentRouter({
        getDomain: () => minimalDomain,
        getWorld: () => ({}),
        getStore: () => store,
      }),
    );
    const res = await request(app)
      .post('/api/agent/invest/exec')
      .send({ intentId: 'buy_asset', params: {} });
    expect(res.status).toBe(401);
  });

  it('400 when intentId missing', async () => {
    const res = await request(buildApp(store))
      .post('/api/agent/invest/exec')
      .send({});
    expect(res.status).toBe(400);
  });

  it('accepts host-format particles {α, target, fields} (sales-crm compat)', async () => {
    const hostFormatDomain: any = {
      ...minimalDomain,
      intents: {
        buy_asset: {
          id: 'buy_asset',
          forRoles: ['agent'],
          parameters: {
            assetId: { type: 'string' },
            assetType: { type: 'string' },
            total: { type: 'number' },
          },
          particles: {
            effects: [
              {
                α: 'add',
                target: 'Transaction',
                fields: {
                  id: '{{auto}}',
                  assetId: '{{params.assetId}}',
                  assetType: '{{params.assetType}}',
                  total: '{{params.total}}',
                  userId: '{{viewer.id}}',
                },
              },
            ],
          },
        },
      },
    };
    const res = await request(buildApp(store, hostFormatDomain))
      .post('/api/agent/invest/exec')
      .send({
        intentId: 'buy_asset',
        params: { assetId: 'a-1', assetType: 'stock', total: 5000 },
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const confirmed = store.all().filter((e: any) => e.entity === 'Transaction');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].alpha).toBe('create');
  });

  it('accepts host-format "target: Entity.field" (replace-kind)', async () => {
    const domain: any = {
      ...minimalDomain,
      intents: {
        qualify_lead: {
          id: 'qualify_lead',
          forRoles: ['agent'],
          parameters: { leadId: { type: 'string' } },
          particles: {
            effects: [
              {
                α: 'replace',
                target: 'Lead.status',
                fields: { id: '{{params.leadId}}', status: 'qualified' },
              },
            ],
          },
        },
      },
      roles: {
        agent: {
          canExecute: ['qualify_lead'],
          preapproval: {
            entity: 'AgentPreapproval',
            ownerField: 'userId',
            requiredFor: [],
            checks: [],
          },
        },
      },
    };
    const res = await request(buildApp(store, domain))
      .post('/api/agent/invest/exec')
      .send({ intentId: 'qualify_lead', params: { leadId: 'lead-1' } });
    expect(res.status).toBe(200);
    const leads = store.all().filter((e: any) => e.entity === 'Lead');
    expect(leads).toHaveLength(1);
    expect(leads[0].alpha).toBe('replace');
    expect(leads[0].fields.status).toBe('qualified');
  });

  it('derived rule effect appended after valid exec', async () => {
    const domainWithRule: any = {
      ...minimalDomain,
      rules: [
        {
          id: 'big_buy_alert',
          kind: 'threshold',
          trigger: { entity: 'Transaction' },
          predicate: { field: 'total', op: 'gt', limit: 3000 },
          action: {
            entity: 'Alert',
            alpha: 'create',
            value: { id: '{{auto}}', message: 'Large buy', severity: 'info' },
          },
        },
      ],
    };
    const res = await request(buildApp(store, domainWithRule))
      .post('/api/agent/invest/exec')
      .send({ intentId: 'buy_asset', params: { assetId: 'a-1', assetType: 'stock', total: 5000 } });
    expect(res.status).toBe(200);
    expect(res.body.derived).toHaveLength(1);
    expect(res.body.derived[0].entity).toBe('Alert');
  });
});
