import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../../src/rules/evaluate';

describe('rules engine (threshold + condition)', () => {
  it('threshold rule fires when value exceeds limit', () => {
    const rules = [
      {
        id: 'high_risk_exotic_alert',
        kind: 'threshold',
        trigger: { entity: 'MarketSignal', kind: 'sentiment' },
        predicate: { field: 'value', op: 'lt', limit: -0.5 },
        action: {
          entity: 'Alert',
          alpha: 'create',
          value: { id: '{{auto}}', message: 'High risk', severity: 'high' },
        },
      },
    ];
    const world = {};
    const effect = {
      entity: 'MarketSignal',
      alpha: 'create',
      value: { id: 's-1', kind: 'sentiment', value: -0.7 },
    };
    const derived = evaluateRules(rules as any, world, effect);
    expect(derived).toHaveLength(1);
    expect(derived[0].entity).toBe('Alert');
  });

  it('threshold rule does not fire when predicate false', () => {
    const rules = [
      {
        id: 'x',
        kind: 'threshold',
        trigger: { entity: 'MarketSignal' },
        predicate: { field: 'value', op: 'lt', limit: -10 },
        action: { entity: 'Alert', alpha: 'create', value: {} },
      },
    ];
    const effect = { entity: 'MarketSignal', alpha: 'create', value: { value: -1 } };
    expect(evaluateRules(rules as any, {}, effect)).toHaveLength(0);
  });

  it('condition rule evaluates JS expression', () => {
    const rules = [
      {
        id: 'big_sell',
        kind: 'condition',
        trigger: { entity: 'Transaction' },
        expression: "effect.value.total > 10000 && effect.value.direction === 'sell'",
        action: {
          entity: 'Recommendation',
          alpha: 'create',
          value: { id: '{{auto}}', type: 'rebalance' },
        },
      },
    ];
    const effect = {
      entity: 'Transaction',
      alpha: 'create',
      value: { total: 15000, direction: 'sell' },
    };
    expect(evaluateRules(rules as any, {}, effect)).toHaveLength(1);
  });

  it('skip rules with non-matching trigger entity', () => {
    const rules = [
      {
        id: 'x',
        kind: 'threshold',
        trigger: { entity: 'Transaction' },
        predicate: { field: 'total', op: 'gt', limit: 0 },
        action: { entity: 'Alert', alpha: 'create', value: {} },
      },
    ];
    const effect = { entity: 'MarketSignal', alpha: 'create', value: {} };
    expect(evaluateRules(rules as any, {}, effect)).toHaveLength(0);
  });

  it('autogenerates id placeholder {{auto}}', () => {
    const rules = [
      {
        id: 'x',
        kind: 'condition',
        trigger: { entity: 'Transaction' },
        expression: 'true',
        action: {
          entity: 'Alert',
          alpha: 'create',
          value: { id: '{{auto}}', message: 'hi' },
        },
      },
    ];
    const effect = { entity: 'Transaction', alpha: 'create', value: {} };
    const d = evaluateRules(rules as any, {}, effect);
    expect(d[0].value.id).toMatch(/^auto-/);
  });

  it('sandbox denies unsafe expressions', () => {
    const rules = [
      {
        id: 'x',
        kind: 'condition',
        trigger: { entity: 'Transaction' },
        expression: 'process.exit(1)',
        action: { entity: 'Alert', alpha: 'create', value: {} },
      },
    ];
    const effect = { entity: 'Transaction', alpha: 'create', value: {} };
    expect(evaluateRules(rules as any, {}, effect)).toHaveLength(0);
  });
});
