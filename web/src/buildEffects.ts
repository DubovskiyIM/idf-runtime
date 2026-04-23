/**
 * Runtime-side generic buildEffects: переводит `(intentId, ctx)` от SDK renderer
 * в массив effect-rows вида `{alpha, entity, fields, context}`, которые принимает
 * `POST /api/effects` на runtime backend.
 *
 * Renderer вызывает `ctx.exec(intentId, ctx)` — где `ctx` это либо payload формы
 * (create), либо `{id, ...params}` для replace/remove. Runtime backend ждёт
 * уже собранный effect, а не intent-id. Нужен thin transform-слой.
 *
 * Минимальный парсер поддерживает:
 *   - intent.α:"create", target:"Lead"              → {alpha:"create", entity:"Lead", fields:{id, ...ctx}}
 *   - intent.α:"replace", target:"Lead.status"      → {alpha:"replace", entity:"Lead", fields:{id, status, ...}}
 *   - intent.α:"remove",  target:"Lead"             → {alpha:"remove",  entity:"Lead", fields:{id}}
 *   - intent.particles.effects[] (post-normalize)   → аналогично выше
 *
 * Host idf использует похожий паттерн (см. DomainRuntime.jsx `makeGenericBuildEffects`),
 * но там effect-шкема другая (`{target, scope, value}`). Runtime здесь — плоский
 * row-level shape (матерь-таблица phi_effects), отсюда раздельная реализация.
 */

type Intent = {
  α?: string;
  alpha?: string;
  target?: string;
  creates?: string;
  parameters?: Array<{ name: string; type?: string; ref?: string; entity?: string }>;
  particles?: {
    effects?: Array<{
      α?: string;
      op?: string;
      target?: string;
      /**
       * Статические defaults/фиксированные значения для effect'а.
       * Используется в phase-transition intents (stage:"qualified") и
       * в create-intents для дефолтов (status:"new"). Мерджится в
       * fields ПЕРЕД ctx — user-input всегда побеждает.
       */
      fields?: Record<string, unknown>;
    }>;
  };
  context?: Record<string, unknown>;
};

type Viewer = { id: string; name?: string } | null;

type RuntimeEffect = {
  alpha: 'create' | 'replace' | 'remove' | 'transition' | 'commit';
  entity: string;
  fields: Record<string, unknown>;
  context?: Record<string, unknown>;
};

const OP_TO_ALPHA: Record<string, string> = {
  insert: 'create',
  add: 'create',
  create: 'create',
  replace: 'replace',
  update: 'replace',
  remove: 'remove',
  delete: 'remove',
};

function canonicalAlpha(raw: string | undefined): RuntimeEffect['alpha'] | null {
  if (!raw) return null;
  const mapped = OP_TO_ALPHA[raw] ?? raw;
  if (mapped === 'create' || mapped === 'replace' || mapped === 'remove') return mapped;
  if (mapped === 'transition' || mapped === 'commit') return mapped;
  return null;
}

function toEntityName(raw: string | undefined, intent: Intent | undefined): string | null {
  if (!raw) return null;
  const base = raw.split('.')[0];
  if (!base) return null;
  // Если normalizeIntentNative понизил target'у кейс ("lead" вместо "Lead"),
  // восстанавливаем CapitalCase. Предпочитаем intent.creates (автор явно указал).
  if (intent?.creates && typeof intent.creates === 'string') return intent.creates;
  if (/^[A-Z]/.test(base)) return base;
  // pluralized lowercase ("leads") → "Lead"
  const singular = base.endsWith('ies')
    ? base.slice(0, -3) + 'y'
    : base.endsWith('es') && base.length > 3
    ? base.slice(0, -2)
    : base.endsWith('s') && base.length > 2
    ? base.slice(0, -1)
    : base;
  return singular[0].toUpperCase() + singular.slice(1);
}

function randomId(entity: string): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${entity.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function findEntityId(ctx: Record<string, unknown>, entity: string): string | undefined {
  if (typeof ctx.id === 'string') return ctx.id;
  if (typeof ctx.entityId === 'string') return ctx.entityId;
  const guess = ctx[`${entity[0].toLowerCase()}${entity.slice(1)}Id`];
  if (typeof guess === 'string') return guess;
  return undefined;
}

export function buildEffectsFromIntent(
  intentId: string,
  ctx: Record<string, unknown>,
  INTENTS: Record<string, unknown>,
  viewer: Viewer,
): RuntimeEffect[] {
  const intent = INTENTS[intentId] as Intent | undefined;
  if (!intent) return [];

  const actorCtx: Record<string, unknown> = {
    ...(intent.context ?? {}),
    ...(viewer?.id ? { actor: viewer.id } : {}),
  };

  // Предпочитаем explicit particles.effects[] (после normalizeIntentNative);
  // fallback на top-level α+target (legacy flat-форма).
  const particleEffects = intent.particles?.effects ?? [];
  const sources: Array<{
    α?: string;
    op?: string;
    target?: string;
    fields?: Record<string, unknown>;
  }> =
    particleEffects.length > 0
      ? particleEffects
      : intent.α || intent.alpha
      ? [{ α: intent.α ?? intent.alpha, target: intent.target }]
      : [];

  const out: RuntimeEffect[] = [];
  for (const src of sources) {
    const α = canonicalAlpha(src.α ?? src.op);
    const entity = toEntityName(src.target, intent);
    if (!α || !entity) continue;

    // src.fields — статические defaults/фиксированные values из ontology
    // (particles.effects[*].fields). Мерджим ПЕРЕД ctx — user-input побеждает.
    // Критично для phase-transition intents (qualify_deal / win_deal / и т.д.),
    // где stage value лежит ТОЛЬКО в src.fields (не в ctx), и для create-intents
    // с дефолтами (create_lead → status:"new").
    const srcFields = (src.fields ?? {}) as Record<string, unknown>;

    if (α === 'create') {
      const id = typeof ctx.id === 'string' ? ctx.id : randomId(entity);
      out.push({
        alpha: 'create',
        entity,
        fields: { ...srcFields, id, ...ctx },
        context: actorCtx,
      });
      continue;
    }

    if (α === 'replace') {
      const id = findEntityId(ctx, entity);
      if (!id) continue;
      const fields: Record<string, unknown> = { id, ...srcFields };
      // dotted target "Lead.status" → если ctx содержит `status`, берём его
      const dotIdx = (src.target ?? '').indexOf('.');
      const fieldName = dotIdx >= 0 ? (src.target ?? '').slice(dotIdx + 1) : null;
      for (const [k, v] of Object.entries(ctx)) {
        if (k === 'id' || k === 'entityId') continue;
        // inline setter передаёт {id, field: value} — включаем всё, что не id
        fields[k] = v;
      }
      // Если dotted target указал поле, а его не оказалось ни в srcFields,
      // ни в ctx — replace молча игнорируется. До fix'а это срабатывало даже
      // для явных phase-transition'ов с fields в particles.effects.
      if (fieldName && fields[fieldName] === undefined) {
        continue;
      }
      out.push({ alpha: 'replace', entity, fields, context: actorCtx });
      continue;
    }

    if (α === 'remove') {
      const id = findEntityId(ctx, entity);
      if (!id) continue;
      out.push({ alpha: 'remove', entity, fields: { id }, context: actorCtx });
      continue;
    }
  }

  return out;
}
