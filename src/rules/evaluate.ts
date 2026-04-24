import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

export type Rule = {
  id: string;
  kind: 'threshold' | 'condition' | 'aggregation' | 'schedule';
  trigger: { entity: string; kind?: string };
  predicate?: { field: string; op: 'lt' | 'gt' | 'lte' | 'gte' | 'eq'; limit: number };
  expression?: string;
  action: { entity: string; alpha: string; value: Record<string, any> };
};

export function evaluateRules(rules: Rule[] | undefined, world: any, effect: any): any[] {
  const derived: any[] = [];
  for (const rule of rules ?? []) {
    if (rule.trigger?.entity !== effect.entity) continue;
    if (rule.trigger?.kind && effect.value?.kind !== rule.trigger.kind) continue;
    let fired = false;
    if (rule.kind === 'threshold') fired = evalThreshold(rule, effect);
    else if (rule.kind === 'condition') fired = evalCondition(rule, effect, world);
    if (fired) derived.push(materializeAction(rule.action));
  }
  return derived;
}

function evalThreshold(rule: Rule, effect: any): boolean {
  const p = rule.predicate;
  if (!p) return false;
  const v = effect.value?.[p.field];
  if (typeof v !== 'number') return false;
  switch (p.op) {
    case 'lt': return v < p.limit;
    case 'gt': return v > p.limit;
    case 'lte': return v <= p.limit;
    case 'gte': return v >= p.limit;
    case 'eq': return v === p.limit;
    default: return false;
  }
}

function evalCondition(rule: Rule, effect: any, world: any): boolean {
  if (!rule.expression) return false;
  try {
    const ctx = vm.createContext({ effect, world });
    const result = vm.runInContext(rule.expression, ctx, {
      timeout: 50,
      displayErrors: false,
    });
    return Boolean(result);
  } catch {
    return false;
  }
}

function materializeAction(action: Rule['action']): any {
  const value = { ...action.value };
  if (value.id === '{{auto}}') value.id = `auto-${randomUUID().slice(0, 8)}`;
  return { entity: action.entity, alpha: action.alpha, value, __derived: true };
}
