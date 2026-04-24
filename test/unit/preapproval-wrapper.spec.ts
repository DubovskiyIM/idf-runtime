import { describe, it, expect } from 'vitest';
import { checkPreapprovalForIntent } from '../../src/validator/preapproval';

describe('preapproval wrapper (per-intent)', () => {
  const ontology = {
    roles: {
      agent: {
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
  };

  const world = {
    agentPreapprovals: [
      {
        id: 'pa-1',
        userId: 'u-1',
        active: true,
        maxOrderAmount: 10000,
        allowedAssetTypes: 'stock,bond,etf',
      },
    ],
    transactions: [],
  };

  const viewer = { id: 'u-1', role: 'agent' };

  it('accepts intent within limits', () => {
    const r = checkPreapprovalForIntent(
      'buy_asset',
      { total: 5000, assetType: 'stock' },
      viewer,
      ontology,
      world,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects when maxAmount exceeded', () => {
    const r = checkPreapprovalForIntent(
      'buy_asset',
      { total: 50000, assetType: 'stock' },
      viewer,
      ontology,
      world,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedCheck).toBe('maxAmount');
  });

  it('rejects disallowed assetType', () => {
    const r = checkPreapprovalForIntent(
      'buy_asset',
      { total: 1000, assetType: 'crypto' },
      viewer,
      ontology,
      world,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedCheck).toBe('csvInclude');
  });

  it('skips intent not в requiredFor', () => {
    const r = checkPreapprovalForIntent(
      'view_portfolio',
      {},
      viewer,
      ontology,
      world,
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok when no preapproval declared', () => {
    const ontologyBare = { roles: { agent: {} } };
    const r = checkPreapprovalForIntent('buy_asset', {}, viewer, ontologyBare, world);
    expect(r.ok).toBe(true);
  });
});
