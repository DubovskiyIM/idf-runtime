import { describe, it, expect } from 'vitest';
import { checkInvariantsForEffect } from '../../src/validator/invariants';

describe('invariants per-effect wrapper', () => {
  const ontology: any = {
    invariants: [
      {
        name: 'position_portfolio_fk',
        kind: 'referential',
        from: 'Position.portfolioId',
        to: 'Portfolio.id',
      },
    ],
    entities: {
      Portfolio: { id: 'Portfolio', fields: { id: { type: 'id' } } },
      Position: {
        id: 'Position',
        fields: { id: { type: 'id' }, portfolioId: { type: 'ref:Portfolio' } },
      },
    },
  };

  it('accepts effect when FK exists', () => {
    const world = { portfolios: [{ id: 'p-1' }], positions: [] };
    const effect = {
      entity: 'Position',
      alpha: 'create',
      value: { id: 'pos-1', portfolioId: 'p-1' },
    };
    const r = checkInvariantsForEffect(effect, ontology, world);
    expect(r.ok).toBe(true);
  });

  it('rejects effect when FK missing', () => {
    const world = { portfolios: [], positions: [] };
    const effect = {
      entity: 'Position',
      alpha: 'create',
      value: { id: 'pos-1', portfolioId: 'nope' },
    };
    const r = checkInvariantsForEffect(effect, ontology, world);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].name).toBe('position_portfolio_fk');
  });

  it('returns ok when no invariants declared', () => {
    const world = {};
    const effect = { entity: 'Whatever', alpha: 'create', value: {} };
    const r = checkInvariantsForEffect(effect, { entities: {} }, world);
    expect(r.ok).toBe(true);
  });
});
