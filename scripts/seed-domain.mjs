import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.DATA_DIR ?? './data';
mkdirSync(DATA, { recursive: true });

const domain = {
  __version: 'seed-v1',
  meta: { id: 'client-onboarding', description: 'Onboarding tracker (seed)' },
  entities: {
    Client: {
      fields: {
        id: { type: 'text' },
        name: { type: 'text', required: true, role: 'primary' },
        currentStage: {
          type: 'select',
          options: ['contract', 'kickoff', 'config', 'training', 'go-live'],
          required: true,
        },
      },
      ownerField: 'csmId',
    },
  },
  intents: {
    add_client: { α: 'create', target: 'Client' },
  },
  roles: {
    csm: {
      base: 'owner',
      canExecute: ['add_client'],
      visibleFields: { Client: ['*'] },
    },
  },
  projections: {
    clients: { archetype: 'catalog', intents: ['add_client'] },
  },
  invariants: [],
  rules: [],
};

writeFileSync(join(DATA, 'domain.json'), JSON.stringify(domain, null, 2));
console.log('[seed] domain.json written →', DATA);
