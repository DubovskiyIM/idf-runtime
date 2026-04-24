import { checkInvariants } from '@intent-driven/core';

export type InvariantViolation = {
  name?: string;
  kind: string;
  severity: string;
  message: string;
  details?: any;
};

export type InvariantResult =
  | { ok: true }
  | { ok: false; violations: InvariantViolation[] };

/**
 * Apply effect-candidate поверх current world снимка и прогнать SDK-валидатор.
 * Возвращает только error-severity violations. Warnings игнорируются.
 *
 * Collection lookup: SDK ожидает pluralize(entity.toLowerCase()) — `Position` → `positions`.
 */
export function checkInvariantsForEffect(
  effect: any,
  ontology: any,
  world: any,
): InvariantResult {
  const invariants = Array.isArray(ontology?.invariants) ? ontology.invariants : [];
  if (invariants.length === 0) return { ok: true };

  const candidateWorld = applyEffectToWorld(world, effect);
  const raw: any = (checkInvariants as any)(candidateWorld, ontology, {});
  const violations = Array.isArray(raw?.violations) ? raw.violations : [];
  const errors = violations
    .filter((v: any) => (v.severity ?? 'error') === 'error')
    .map((v: any) => ({
      name: v.name,
      kind: v.kind,
      severity: v.severity ?? 'error',
      message: v.message ?? '',
      details: v.details ?? {},
    }));

  if (errors.length === 0) return { ok: true };
  return { ok: false, violations: errors };
}

function pluralizeCollection(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower.endsWith('s')) return lower + 'es';
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies';
  return lower + 's';
}

function applyEffectToWorld(world: any, effect: any): any {
  const next: any = { ...world };
  const key = pluralizeCollection(effect.entity);
  const rows = [...(next[key] ?? [])];

  if (effect.alpha === 'create') {
    rows.push(effect.value);
  } else if (effect.alpha === 'replace') {
    const idx = rows.findIndex((r) => r.id === effect.value.id);
    if (idx >= 0) rows[idx] = { ...rows[idx], ...effect.value };
    else rows.push(effect.value);
  } else if (effect.alpha === 'remove') {
    const idx = rows.findIndex((r) => r.id === effect.value.id);
    if (idx >= 0) rows.splice(idx, 1);
  }

  next[key] = rows;
  return next;
}
