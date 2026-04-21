import type { PhiStore, ConfirmedEffect } from '../phi/store.js';
import { checkInvariants } from '@intent-driven/core';

export type IntegrityRejection = {
  effectId: string;
  reason: string;
  details?: string;
};

export type IntegrityCheckResult = {
  ok: boolean;
  totalEffects: number;
  rejectedEffects: IntegrityRejection[];
};

/**
 * Rebuild-from-Φ проверка: прогоняем все confirmed-эффекты под новой ontology,
 * собираем список нарушений. Используется в `POST /admin/reload` как gate
 * перед заменой активной ontology.
 *
 * Проверки:
 *  1. unknown_entity — в ontology больше нет entity, на который ссылается эффект.
 *  2. required_field_missing — на create/replace отсутствует поле, ставшее required.
 *  3. invariants — одним вызовом на свёрнутом world (SDK `checkInvariants`).
 */
export function checkIntegrity(store: PhiStore, ontology: any): IntegrityCheckResult {
  const effects = store.all();
  const rejectedEffects: IntegrityRejection[] = [];
  const entityDefs: Record<string, any> = ontology?.entities ?? {};
  const world: Record<string, Record<string, any>> = {};

  for (const e of effects) {
    // 1. Unknown entity — entity удалён из новой ontology
    if (!entityDefs[e.entity]) {
      rejectedEffects.push({
        effectId: e.id,
        reason: 'unknown_entity',
        details: `Entity "${e.entity}" removed from ontology`,
      });
      continue;
    }

    // 2. Required fields — проверяем только на create/replace,
    //    transition/commit/remove не несут полной fields-карты.
    const fieldDefs: Record<string, any> = entityDefs[e.entity]?.fields ?? {};
    if (e.alpha === 'create' || e.alpha === 'replace') {
      for (const [fname, fdef] of Object.entries(fieldDefs)) {
        if (fdef?.required && e.fields[fname] == null) {
          rejectedEffects.push({
            effectId: e.id,
            reason: 'required_field_missing',
            details: `${e.entity}.${fname} now required`,
          });
        }
      }
    }

    // 3. Проигрываем эффект в локальный world для последующей invariant-проверки
    applyEffectToWorld(world, e);
  }

  // 4. Инварианты — один вызов на финальном world
  try {
    const res = checkInvariants(world, ontology, {}) as any;
    const violations = Array.isArray(res?.violations) ? res.violations : [];
    for (const v of violations) {
      if (v?.severity && v.severity !== 'error') continue; // warnings не блокируют reload
      rejectedEffects.push({
        effectId: 'aggregate',
        reason: `invariant_${v?.kind ?? 'violation'}`,
        details: v?.message ?? v?.details?.message,
      });
    }
  } catch (err: any) {
    rejectedEffects.push({
      effectId: 'aggregate',
      reason: 'invariant_error',
      details: err?.message ?? String(err),
    });
  }

  return {
    ok: rejectedEffects.length === 0,
    totalEffects: effects.length,
    rejectedEffects,
  };
}

function applyEffectToWorld(
  world: Record<string, Record<string, any>>,
  e: ConfirmedEffect
): void {
  if (!world[e.entity]) world[e.entity] = {};
  const id = e.fields.id as string | undefined;
  if (e.alpha === 'create' && id) {
    world[e.entity][id] = { ...e.fields };
  } else if (e.alpha === 'replace' && id) {
    world[e.entity][id] = { ...(world[e.entity][id] ?? {}), ...e.fields };
  } else if (e.alpha === 'remove' && id) {
    delete world[e.entity][id];
  }
  // transition/commit не влияют на shape для integrity-check
}
