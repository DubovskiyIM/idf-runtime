import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { ProjectionRendererV2 } from '@intent-driven/renderer';
import {
  crystallizeV2,
  deriveProjections,
  generateCreateProjections,
  generateEditProjections,
  normalizeIntentsMap,
} from '@intent-driven/core';
import { AntdAdapterProvider } from '@intent-driven/adapter-antd';
import '@intent-driven/adapter-antd/styles.css';
import 'antd/dist/reset.css';
import { buildEffectsFromIntent } from './buildEffects';

// AntD — более стабильный peer-граф (react>=18, antd>=5); host idf использует
// mantine+react19, runtime остаётся на react18 — поэтому antd.

type FlatDomain = {
  meta?: { id?: string; description?: string };
  entities?: Record<string, unknown>;
  intents?: Record<string, unknown>;
  roles?: Record<string, { base?: string; canExecute?: string[] }>;
  invariants?: unknown[];
  projections?: Record<string, unknown>;
};

type NestedDomain = {
  meta: { id: string; description?: string };
  INTENTS: Record<string, unknown>;
  PROJECTIONS: Record<string, unknown>;
  ONTOLOGY: {
    entities: Record<string, unknown>;
    roles: Record<string, unknown>;
    invariants: unknown[];
  };
  DOMAIN_NAME?: string;
};

type MaybeNested = FlatDomain & Partial<NestedDomain>;

/**
 * Очищает entity.fields от:
 *  - null-значений (mergePatch оставляет {x:null} при «удалить X» — SDK
 *    detectForeignKeys ждёт object с .type, null ломает)
 *  - invalid entityRef — fields с type:"entityRef" без target entity/ref.
 *    Claude по ошибке создаёт `{bookId: {type:"entityRef"}}` без указания
 *    куда ссылка. SDK инферит self-ref (по имени поля → Entity), рисует
 *    странный self-subcollection на detail page. Strip такие fields до
 *    crystallize.
 *  - dangling entityRef — ссылка на сущность, которой нет в ontology.
 *    Тоже приводит к broken subcollections.
 */
function sanitizeEntities(
  entities: Record<string, unknown>,
): Record<string, { fields: Record<string, unknown>; [k: string]: unknown }> {
  const out: Record<string, { fields: Record<string, unknown>; [k: string]: unknown }> = {};
  const entityNames = new Set(
    Object.keys(entities ?? {}).filter((k) => entities[k as keyof typeof entities] != null),
  );
  for (const [name, entity] of Object.entries(entities ?? {})) {
    if (!entity || typeof entity !== 'object') continue;
    const src = entity as { fields?: Record<string, unknown>; [k: string]: unknown };
    const fields: Record<string, unknown> = {};
    for (const [fname, fspec] of Object.entries(src.fields ?? {})) {
      if (!fspec || typeof fspec !== 'object') continue;
      const fd = fspec as { type?: string; entity?: string; ref?: string };
      if (fd.type === 'entityRef') {
        const target = fd.entity ?? fd.ref;
        // Нет target вообще — skip (Claude забыл/ошибся)
        if (!target || typeof target !== 'string') continue;
        // Target не объявлен как entity — skip (dangling ref)
        if (!entityNames.has(target)) continue;
      }
      fields[fname] = fspec;
    }
    out[name] = { ...src, fields };
  }
  return out;
}

/**
 * Detect-then-normalize: runtime /api/domain может отдать:
 *  (a) flat shape  (legacy loader): { entities, intents, roles, projections, invariants, meta }
 *  (b) nested shape (studio seedDomain пишет как есть): { INTENTS, PROJECTIONS, ONTOLOGY:{entities, roles, invariants}, meta }
 *
 * Выбираем по наличию uppercase ключей.
 */
/**
 * Coerce non-canonical α (`update`, `add`, `insert`, `delete`) в canonical.
 *
 * SDK crystallizeV2 / deriveProjections strict'но ждут одно из
 * `create|replace|remove|transition|commit|read`. Любая non-canonical
 * α крашит crystallize, TenantApp показывает `<NoProjections>` stub.
 *
 * Claude-авторинг иногда эмитит legacy aliases (`update` на Customer.walletBalance).
 * До fix'а это был silent-fail: artifactsMap={}, rootProjectionIds=[],
 * весь UI превращался в пустую заглушку. Теперь coerce'им до SDK-call'а
 * и sanitize'им intent-by-intent.
 */
const ALPHA_ALIASES: Record<string, string> = {
  update: 'replace',
  add: 'create',
  insert: 'create',
  delete: 'remove',
};
function coerceAlpha(a: unknown): string | undefined {
  if (typeof a !== 'string') return undefined;
  return ALPHA_ALIASES[a] ?? a;
}
function normalizeIntentAlphas(
  intents: Record<string, unknown>,
): { intents: Record<string, unknown>; coerced: Array<{ id: string; from: string; to: string }> } {
  const out: Record<string, unknown> = {};
  const coerced: Array<{ id: string; from: string; to: string }> = [];
  for (const [id, raw] of Object.entries(intents ?? {})) {
    if (!raw || typeof raw !== 'object') {
      out[id] = raw;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const rawAlpha = typeof r.α === 'string' ? (r.α as string) : typeof r.alpha === 'string' ? (r.alpha as string) : undefined;
    const canonical = coerceAlpha(rawAlpha);
    if (rawAlpha && canonical && rawAlpha !== canonical) {
      coerced.push({ id, from: rawAlpha, to: canonical });
      out[id] = { ...r, α: canonical, alpha: canonical };
    } else {
      out[id] = r;
    }
  }
  return { intents: out, coerced };
}

/**
 * Coerce remove-intents с одним id-параметром в click-confirm + __irr.
 *
 * Симптом до fix'а: клик «Удалить жанр» в row-menu открывал form-modal
 * с пустым dropdown'ом «выбери жанр» вместо confirm-dialog'а. SDK по
 * умолчанию ждёт form-overlay если intent.parameters непуст и
 * intent.confirmation не установлен.
 *
 * Для `delete_genre(genreId)` / `delete_book(bookId)` — параметр уже
 * известен из row.id, форма не нужна. Патчим intent:
 *   confirmation: "click"
 *   context.__irr: { point: "high" }  — SDK рисует confirm-dialog
 *
 * Параметр резолвится из item.id автоматически в SDK IntentButton
 * → triggerAction → exec с ctx=row.
 */
function coerceSingleIdRemoveToClickConfirm(
  intents: Record<string, unknown>,
  ontologyEntities: Record<string, unknown>,
): Record<string, unknown> {
  const entityNames = Object.keys(ontologyEntities ?? {});
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(intents ?? {})) {
    if (!raw || typeof raw !== 'object') {
      out[id] = raw;
      continue;
    }
    const r = raw as {
      α?: string;
      alpha?: string;
      target?: string;
      parameters?: Array<{ name?: string }>;
      confirmation?: string;
      context?: Record<string, unknown>;
    };
    const α = r.α ?? r.alpha;
    const target = r.target ?? '';
    if (α !== 'remove') {
      out[id] = r;
      continue;
    }
    const mainEntity = target.split('.')[0];
    if (!entityNames.includes(mainEntity)) {
      out[id] = r;
      continue;
    }
    const entityLower = mainEntity[0].toLowerCase() + mainEntity.slice(1);
    const ownIdName = `${entityLower}Id`;
    const params = r.parameters ?? [];
    const isSingleOwnId =
      params.length === 1 &&
      typeof params[0]?.name === 'string' &&
      (params[0].name === ownIdName || params[0].name === 'id' || params[0].name === 'entityId');
    if (!isSingleOwnId) {
      out[id] = r;
      continue;
    }
    // Не перезаписываем author-заданное confirmation
    const hasExplicit = typeof r.confirmation === 'string';
    out[id] = {
      ...r,
      confirmation: hasExplicit ? r.confirmation : 'click',
      context: {
        ...(r.context ?? {}),
        __irr:
          (r.context?.__irr as unknown) ??
          { point: 'high', reason: 'Удаление не отменить' },
      },
    };
  }
  return out;
}

function toNested(raw: MaybeNested): NestedDomain {
  const isNested =
    raw && typeof raw === 'object' &&
    (raw.INTENTS !== undefined || raw.ONTOLOGY !== undefined);

  if (isNested) {
    return {
      meta: { id: raw.meta?.id ?? 'tenant', description: raw.meta?.description },
      INTENTS: raw.INTENTS ?? {},
      PROJECTIONS: raw.PROJECTIONS ?? {},
      ONTOLOGY: {
        entities: sanitizeEntities(raw.ONTOLOGY?.entities ?? {}),
        roles: raw.ONTOLOGY?.roles ?? {},
        invariants: raw.ONTOLOGY?.invariants ?? [],
      },
      DOMAIN_NAME: raw.meta?.id,
    };
  }

  return {
    meta: { id: raw.meta?.id ?? 'tenant', description: raw.meta?.description },
    INTENTS: raw.intents ?? {},
    PROJECTIONS: raw.projections ?? {},
    ONTOLOGY: {
      entities: sanitizeEntities(raw.entities ?? {}),
      roles: raw.roles ?? {},
      invariants: raw.invariants ?? [],
    },
    DOMAIN_NAME: raw.meta?.id,
  };
}

type EffectRow = {
  id?: string;
  alpha: string;
  entity: string;
  fields: Record<string, unknown>;
  context?: Record<string, unknown>;
};

/** Читаемое имя для derived projection'а без authored proj.name. */
function humanizeId(id: string): string {
  return id
    .replace(/^my_/, 'мои ')
    .replace(/_list$/, '')
    .replace(/_feed$/, '')
    .replace(/_detail$/, '')
    .replace(/_create$/, ': создать')
    .replace(/_edit$/, ': изменить')
    .replace(/_/g, ' ');
}

type Toast = {
  id: string;
  kind: 'error' | 'warn' | 'info';
  title: string;
  details?: string;
};

/**
 * Читаемые labels для validator-reason codes. Runtime validator emit'ает
 * канонические strings (unknown_role, role_cannot_execute, invariant_*, и т.д.);
 * UI делает их user-friendly. Неизвестные codes показываются as-is.
 */
const REASON_LABELS: Record<string, string> = {
  unknown_role: 'Роль не объявлена в ontology',
  role_cannot_execute: 'Роль не имеет прав на это действие',
  invariant_referential: 'Нарушение referential integrity (broken FK)',
  invariant_cardinality: 'Нарушение cardinality (слишком много записей)',
  invariant_transition: 'Недопустимый переход состояния',
  invariant_aggregate: 'Нарушение агрегата (сумма / count вышел за предел)',
  invariant_expression: 'Нарушение инварианта',
  invariant_role_capability: 'Роль не может выполнить это действие (capability)',
  preapproval: 'Агент-лимит превышен (preapproval)',
  preapproval_error: 'Ошибка проверки preapproval',
  invalid_effect: 'Effect не прошёл schema-валидацию',
  no_viewer: 'Нет авторизации',
};

/**
 * Augment catalog artifacts: inject per-row intents в slots.body.item.intents.
 *
 * SDK на 0.59 промотировал только `catalog-default-datagrid` и
 * `catalog-creator-toolbar` в stable — row-contextual-actions-menu остаётся
 * в `candidate` (matching-only, без structure.apply). Поэтому catalog-artifact
 * выходит из crystallize без delete/phase-transition кнопок.
 *
 * Detect'им intents подходящие per-row:
 *   - α:"remove" target=mainEntity (Delete)
 *   - α:"replace" target="mainEntity.<field>" (phase transitions типа pay_order)
 *   - intent принимает ровно один id-параметр, совпадающий с mainEntity
 *     (orderId для Order, genreId для Genre — не multi-entity)
 *
 * Shop-пример: `delete_genre` (α:remove target:Genre, params:[genreId])
 * → добавляется в Genre catalog как 🗑 Delete per-row.
 */
function augmentCatalogRowIntents(
  artifacts: Record<string, any>,
  INTENTS: Record<string, any>,
  viewerCanExecute: Set<string> | null,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [pid, art] of Object.entries(artifacts)) {
    if (art?.archetype !== 'catalog' || !art.mainEntity) {
      out[pid] = art;
      continue;
    }
    const mainEntity: string = art.mainEntity;
    const entityLower = mainEntity[0].toLowerCase() + mainEntity.slice(1);
    const ownIdParam = `${entityLower}Id`;

    const perRow: Array<{
      intentId: string;
      label: string;
      icon: string;
      danger: boolean;
      conditions: string[];
    }> = [];
    for (const [iid, intent] of Object.entries(INTENTS)) {
      const α = (intent?.α ?? intent?.alpha) as string | undefined;
      const target = (intent?.target ?? '') as string;

      const isRemoveThis = α === 'remove' && target === mainEntity;
      const isReplaceThisField = α === 'replace' && target.startsWith(mainEntity + '.');
      if (!isRemoveThis && !isReplaceThisField) continue;

      // Role-based filter: если viewer's роль объявлена и canExecute не
      // содержит этот intent — скрываем. null означает bypass-mode
      // (tenant-owner / roles.canExecute не объявлен).
      if (viewerCanExecute && !viewerCanExecute.has(iid)) continue;

      const params = (intent?.parameters ?? []) as Array<{ name?: string; entity?: string; ref?: string }>;
      const hasOwnId = params.some(
        (p) => p?.name === ownIdParam || p?.name === 'id' || p?.name === 'entityId',
      );
      if (!hasOwnId) continue;

      // intent с несколькими entity-параметрами → требует доп-контекст,
      // не чистый per-row action (пропускаем).
      const otherEntityParams = params.filter(
        (p) =>
          p?.name &&
          p.name !== ownIdParam &&
          p.name !== 'id' &&
          typeof p.name === 'string' &&
          p.name.endsWith('Id'),
      );
      if (otherEntityParams.length > 0) continue;

      // Conditions берём из intent.particles.conditions (SDK core @0.64+
      // нормализует author-объявленный intent.precondition туда через
      // compilePreconditionToConditions). Host больше ничего не выводит из
      // effect.fields — см. SDK PR #287.
      const conditions: string[] = Array.isArray(intent?.particles?.conditions)
        ? [...(intent.particles.conditions as string[])]
        : [];

      perRow.push({
        intentId: iid,
        label: (intent?.name as string | undefined) ?? iid,
        icon: isRemoveThis ? '🗑' : '⚡',
        danger: isRemoveThis,
        conditions,
      });
    }

    // Заменяем item.intents целиком, а не мерджим с existing:
    // SDK patterns (catalog-creator-toolbar и др.) накидывают в
    // item.intents всякий noise (read-intents типа list_genres /
    // list_orders, которые в row-меню выглядят как "Заказы" — навигация
    // не должна жить на row). Host делает явное решение: role-filtered
    // remove/replace — и только их.
    const existingAuthored = (art.slots?.body?.item?.intents ?? []) as Array<{
      intentId?: string;
      authored?: boolean;
    }>;
    // Сохраняем ТОЛЬКО intent'ы с explicit authored=true (author-override).
    // SDK-generated без этого флага — дропаем.
    const authoredPreserved = existingAuthored.filter((i) => i?.authored === true);

    const finalIntents = [...authoredPreserved, ...perRow];
    if (finalIntents.length === 0 && existingAuthored.length === 0) {
      out[pid] = art;
      continue;
    }

    out[pid] = {
      ...art,
      slots: {
        ...art.slots,
        body: {
          ...art.slots.body,
          item: {
            ...(art.slots?.body?.item ?? {}),
            intents: finalIntents,
          },
        },
      },
    };
  }
  return out;
}

/**
 * Stripпит treeNav-primitive'ы из catalog artifacts.
 * SDK pattern `hierarchy-tree-nav` авто-inject'ит его в slots.sidebar
 * когда entity имеет sub-entities через FK. MVP shell рендерит это
 * как отдельный блок «ИЕРАРХИЯ» что запутывает PM'а — удаляем.
 */
function stripHierarchyTreeNav(artifacts: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [pid, art] of Object.entries(artifacts)) {
    if (art?.archetype !== 'catalog' || !art.slots) {
      out[pid] = art;
      continue;
    }
    const sidebarNoTree = Array.isArray(art.slots.sidebar)
      ? art.slots.sidebar.filter(
          (node: { type?: string }) => node?.type !== 'treeNav',
        )
      : art.slots.sidebar;
    if (sidebarNoTree === art.slots.sidebar) {
      out[pid] = art;
      continue;
    }
    out[pid] = {
      ...art,
      slots: { ...art.slots, sidebar: sidebarNoTree },
    };
  }
  return out;
}

function humanizeReason(reason: string | undefined): string {
  if (!reason) return 'Отклонено';
  return REASON_LABELS[reason] ?? reason;
}

/**
 * SDK's `assignToSlotsCatalog.pluralizeLower` — должно 1-в-1 совпадать,
 * иначе world[source] не матчится. Копия чтобы не тянуть core.
 */
function pluralizeLower(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies';
  if (lower.endsWith('s')) return lower + 'es';
  return lower + 's';
}

/** CamelCase plural для filterWorld legacy: OrderItem → orderItems. */
function camelPluralize(entity: string): string {
  if (!entity) return entity;
  const head = entity[0].toLowerCase() + entity.slice(1);
  if (head.endsWith('y')) return head.slice(0, -1) + 'ies';
  if (head.endsWith('s')) return head + 'es';
  return head + 's';
}

/**
 * Сворачивает Φ-trail в world. Три shape'а одновременно — чтобы SDK-
 * внутренние lookups все попадали:
 *   - `world.genres`   — plural-lower, ARRAY (DataGrid `ctx.world[node.source]`)
 *   - `world.orderItems` — camel-plural, ARRAY (filterWorld camelPluralize)
 *   - `world.Genre`    — CapitalCase, ARRAY (legacy dotted-witness fallback)
 *
 * До fix'а возвращали только `{Entity: {id: row}}` — SDK'шный DataGrid
 * ждёт массив, получал object → `Array.isArray` false → items=[] →
 * catalog рендерится пустым несмотря на записи в Φ. (shop: 16 Genre
 * visible в /api/effects, UI показывает «пусто».)
 */
function foldEffects(effects: EffectRow[]): Record<string, unknown> {
  const byEntity: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const e of effects) {
    const id = e.fields?.id as string | undefined;
    if (!id) continue;
    if (!byEntity[e.entity]) byEntity[e.entity] = {};
    if (e.alpha === 'create') {
      byEntity[e.entity][id] = { ...e.fields };
    } else if (e.alpha === 'replace') {
      byEntity[e.entity][id] = { ...(byEntity[e.entity][id] ?? {}), ...e.fields };
    } else if (e.alpha === 'remove') {
      delete byEntity[e.entity][id];
    }
  }
  const world: Record<string, unknown> = {};
  for (const [entity, rowsById] of Object.entries(byEntity)) {
    const rows = Object.values(rowsById);
    const plural = pluralizeLower(entity);
    const camel = camelPluralize(entity);
    world[plural] = rows;
    if (camel !== plural) world[camel] = rows;
    // Сохраняем CapitalCase для legacy eval — dotted witnesses `Entity[id]`.
    world[entity] = rows;
  }
  return world;
}

export function TenantApp() {
  const [domain, setDomain] = useState<FlatDomain | null>(null);
  const [effects, setEffects] = useState<EffectRow[]>([]);
  const [activeProjectionId, setActiveProjectionId] = useState<string | null>(null);
  // routeParams нужен SDK'шному ArchetypeDetail для resolve id через idParam:
  //   const id = parentCtx.routeParams?.[projection.idParam];
  // Без prop'а detail всегда падает в «Выбери элемент из списка» после
  // item-click'а из catalog'а.
  const [routeParams, setRouteParams] = useState<Record<string, string>>({});
  // Nav-history стек — чтобы back() возвращал на catalog, не в emptyState.
  const [navStack, setNavStack] = useState<Array<{ pid: string; params: Record<string, string> }>>([]);
  const [error, setError] = useState<string | null>(null);
  // Viewer init'ится с safe fallback (role="owner" — super-bypass в validator
  // если ontology его не объявит); фактическое значение из /api/viewer
  // перезаписывает при mount'е, чтобы renderer filter'ил projections
  // по реальной роли из JWT.
  const [viewer, setViewer] = useState<{ id: string; name: string; role: string }>({
    id: 'tenant-viewer',
    name: 'Tenant',
    role: 'owner',
  });
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 6000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const refreshEffects = useCallback(async () => {
    try {
      const res = await fetch('/api/effects', { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return;
        throw new Error(`effects fetch ${res.status}`);
      }
      const data = await res.json();
      setEffects(Array.isArray(data) ? data : data.effects ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('refreshEffects:', msg);
    }
  }, []);

  useEffect(() => {
    fetch('/api/domain')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`domain ${r.status}`))))
      .then((d: FlatDomain) => setDomain(d))
      .catch((e) => setError(e.message));

    fetch('/api/viewer', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { userId?: string; role?: string } | null) => {
        if (v?.userId && v.role) {
          setViewer({ id: v.userId, name: v.userId.slice(0, 8), role: v.role });
        }
      })
      .catch(() => {
        // 401 — без JWT останемся на fallback'е; UI и так ограничен viewer-routes
      });

    refreshEffects();
  }, [refreshEffects]);

  const {
    nested,
    mergedProjections,
    artifacts,
    rootProjectionIds,
    world,
    domainId,
    description,
    isEmpty,
    diagnostics,
    ontologyRoles,
  } = useMemo(() => {
    const emptyReturn = {
      nested: null,
      mergedProjections: {} as Record<string, any>,
      artifacts: {} as Record<string, any>,
      rootProjectionIds: [] as string[],
      world: {} as Record<string, unknown>,
      domainId: 'tenant',
      description: undefined as string | undefined,
      isEmpty: true,
      diagnostics: undefined as
        | undefined
        | {
            entitiesCount: number;
            intentsCount: number;
            readIntents: string[];
            writeIntents: string[];
            entities: string[];
            artifactsCount: number;
          },
      ontologyRoles: {} as Record<string, { base?: string; visibleFields?: unknown }>,
    };
    if (!domain) return emptyReturn;

    const n = toNested(domain);

    // Сначала — coerce non-canonical α (update/add/insert/delete → canonical).
    // Без этого Claude-авторинг с одним ошибочным α ломал крyстализацию
    // целиком и user'у показывался NoProjections stub.
    const { intents: canonicalIntents, coerced } = normalizeIntentAlphas(
      n.INTENTS as Record<string, unknown>,
    );
    if (coerced.length > 0) {
      console.warn(
        '[TenantApp] coerced non-canonical α (Claude authoring glitch):',
        coerced.map((c) => `${c.id}: ${c.from}→${c.to}`).join(', '),
      );
    }

    // Coerce `remove` intents с одним id-параметром в click-confirm + __irr.
    // Иначе SDK default: parameters непуст → form-overlay → user видит
    // пустой dropdown вместо confirm-dialog'а «удалить Роман?».
    const clickFriendlyIntents = coerceSingleIdRemoveToClickConfirm(
      canonicalIntents,
      n.ONTOLOGY.entities as Record<string, unknown>,
    );

    // normalizeIntentsMap обязателен: template'ы / importer-output хранят
    // intents в flat-форме `{α, target, parameters}` без `particles.effects` и
    // `creates`. Без normalize analyzeIntents не находит creators/mutators —
    // результат: rootProjectionIds = [] и NoProjections stub вместо UI.
    const rawINTENTS = normalizeIntentsMap(clickFriendlyIntents) as Record<string, any>;

    // Role-based filter. Рассчитываем viewerCanExecute ДО crystallize'а и
    // фильтруем INTENTS — без этого customer видит creator-кнопки
    // («Добавить книгу») даже если add_book не в his canExecute. SDK
    // crystallize role-agnostic: каждый viewer получает полный artefact
    // где и kebab-меню, и toolbar creator содержат все intent'ы подряд.
    // Фильтрация up-front даёт чистый artefact для текущего viewer'а —
    // SDK сам не сгенерирует create-projection для отфильтрованного intent'а,
    // и hero/toolbar/row-menu все три становятся role-aware разом.
    const ontologyRolesMap = (n.ONTOLOGY.roles ?? {}) as Record<
      string,
      { base?: string; canExecute?: string[] | '*' }
    >;
    const declaredRoleNames = Object.keys(ontologyRolesMap);
    let effectiveRoleForFilter: string | null = declaredRoleNames.includes(viewer.role)
      ? viewer.role
      : null;
    if (effectiveRoleForFilter === null && declaredRoleNames.length > 0) {
      effectiveRoleForFilter =
        declaredRoleNames.find((r) => ontologyRolesMap[r]?.base === 'admin') ??
        declaredRoleNames[0];
    }
    const roleDef = effectiveRoleForFilter ? ontologyRolesMap[effectiveRoleForFilter] : null;
    const canExec = roleDef?.canExecute;
    // canExecute '*' или отсутствует → bypass (null = no filter).
    // base:"admin"/"owner" (без явного canExecute) тоже даёт bypass —
    // см. ontologyRolesMap[role].base выше.
    const viewerCanExecute: Set<string> | null =
      canExec === '*' || !Array.isArray(canExec) ? null : new Set(canExec);

    // Отфильтрованные INTENTS передаём во ВСЕ downstream-функции
    // (deriveProjections / generateCreate / generateEdit / crystallizeV2).
    // null — bypass-режим (admin / tenant-owner / canExecute не объявлен).
    const INTENTS: Record<string, any> =
      viewerCanExecute === null
        ? rawINTENTS
        : Object.fromEntries(
            Object.entries(rawINTENTS).filter(([id]) => viewerCanExecute.has(id)),
          );

    const derived = (() => {
      try {
        return deriveProjections(INTENTS, n.ONTOLOGY) ?? {};
      } catch (e) {
        console.warn('deriveProjections failed:', e);
        return {};
      }
    })();
    const createProjs = (() => {
      try {
        return generateCreateProjections(INTENTS, n.PROJECTIONS ?? {}, n.ONTOLOGY) ?? {};
      } catch (e) {
        console.warn('generateCreateProjections failed:', e);
        return {};
      }
    })();
    const editProjs = (() => {
      try {
        return generateEditProjections(INTENTS, n.PROJECTIONS ?? {}, n.ONTOLOGY) ?? {};
      } catch (e) {
        console.warn('generateEditProjections failed:', e);
        return {};
      }
    })();
    // Authored PROJECTIONS перекрывают derived+create+edit поверх.
    const merged: Record<string, any> = { ...derived, ...createProjs, ...editProjs };
    for (const [id, authored] of Object.entries(n.PROJECTIONS ?? {})) {
      merged[id] = merged[id] ? { ...merged[id], ...(authored as any) } : authored;
    }

    // crystallizeV2 signature: (INTENTS, PROJECTIONS, ONTOLOGY, domainId, opts)
    let artifactsMap: Record<string, any> = {};
    try {
      artifactsMap = crystallizeV2(INTENTS, merged, n.ONTOLOGY, n.meta.id) ?? {};
    } catch (e) {
      console.warn('crystallizeV2 failed:', e);
    }

    // row-contextual-actions-menu ещё candidate в SDK — augment'им руками:
    // inject delete/phase-transition intent'ы в item.intents каждого catalog'а.
    // INTENTS уже отфильтрован по canExecute — augment работает с тем же set'ом.
    artifactsMap = augmentCatalogRowIntents(artifactsMap, INTENTS, viewerCanExecute);

    // SDK pattern `hierarchy-tree-nav` автоматически добавляет
    // `slots.sidebar: [{type:"treeNav"}]` к catalog'у, у которого
    // есть sub-entities через FK. В текущем shell'е это рисуется как
    // странный «ИЕРАРХИЯ Genre → Book → CartItem» блок рядом с list'ом.
    // Для MVP stripпим — порт правильного TreeNav requires renderer
    // работы. PM видел хаос, не помощь.
    artifactsMap = stripHierarchyTreeNav(artifactsMap);

    // Ontology-declared role names — для маппинга JWT-роли PM'а (tenant-owner)
    // на роль, которую renderer поймёт. Если JWT.role нет в ontology.roles,
    // SDK filter даёт пустой мир + нулевые visibleFields → список выглядит
    // пустым несмотря на записи в Φ. Fallback: роль с base:"admin" как
    // наиболее широкая по visibleFields; иначе — первая объявленная.
    const ontologyRoles = (n.ONTOLOGY.roles ?? {}) as Record<
      string,
      { base?: string; visibleFields?: unknown }
    >;

    // Root projections: правильный nav-set для shell'а.
    //
    // До fix'а был только фильтр по absorbedBy — это пускало в top-nav:
    //  - form-архетипы (book_create etc) — должны быть CTA на catalog'е
    //  - detail-архетипы non-singleton (book_detail, order_detail) — открываются
    //    через item-click из catalog'а, сами по себе в nav дают hub-view
    //    без выбранного элемента («Пусто» справа)
    //  - при этом absorbed catalog'и (order_list absorbedBy=book_detail)
    //    полностью терялись, т.к. их absorber был скрыт и detail тоже
    //
    // Правильный фильтр:
    //  1. form — всегда hide
    //  2. detail non-singleton — hide (singleton-detail типа my_wallet оставляем)
    //  3. absorbedBy — если absorber visible (catalog), hide; если absorber
    //     сам скрыт (detail/form) → promote (absorbed catalog становится root)
    const isHiddenFromNav = (a: any): boolean => {
      if (!a) return true;
      if (a.archetype === 'form') return true;
      if (a.archetype === 'detail' && !a.singleton) return true;
      return false;
    };

    // Role-aware filter: проекция видна, если projection.forRoles отсутствует
    // (видна всем) или содержит current viewer.role.
    const isVisibleForRole = (pid: string): boolean => {
      const proj = (merged as Record<string, any>)[pid];
      const forRoles: unknown = proj?.forRoles;
      if (!Array.isArray(forRoles) || forRoles.length === 0) return true;
      return forRoles.includes(viewer.role);
    };

    // Если автор объявил domain.ROOT_PROJECTIONS — это explicit nav contract,
    // используем его как-есть (intersected с artifactsMap + role filter).
    // Поддерживает custom-archetype projections (e.g. agent_console), которые
    // не появляются в derived nav через Object.keys(artifactsMap).
    //
    // Поддерживаются 2 формата:
    //   - flat array: ["agent_console", "portfolio_list", ...]
    //   - sectioned:  [{section:"...", items:["..."]}] (V2Shell-compat)
    //
    // Fallback на derived (текущая логика) — только если ROOT_PROJECTIONS отсутствует.
    const rawRoot = (n as { ROOT_PROJECTIONS?: unknown }).ROOT_PROJECTIONS;
    let authoredRootIds: string[] | null = null;
    if (Array.isArray(rawRoot) && rawRoot.length > 0) {
      const flatList: string[] = typeof rawRoot[0] === 'object'
        ? (rawRoot as Array<{ items?: string[] }>).flatMap((s) => s.items ?? [])
        : (rawRoot as string[]);
      authoredRootIds = flatList.filter(
        (pid) => artifactsMap[pid] && isVisibleForRole(pid)
      );
    }

    const rootIds = authoredRootIds ?? Object.keys(artifactsMap).filter((pid) => {
      const a = artifactsMap[pid];
      if (isHiddenFromNav(a)) return false;
      if (a?.absorbedBy) {
        const absorber = artifactsMap[a.absorbedBy];
        if (absorber && !isHiddenFromNav(absorber)) return false; // absorbed в visible hub
        // absorber скрыт → promote (иначе catalog вообще никак не достанешь)
      }
      return isVisibleForRole(pid);
    });

    const entitiesCount = Object.keys(n.ONTOLOGY.entities ?? {}).length;
    const intentsCount = Object.keys(n.INTENTS ?? {}).length;

    // Diagnostics для empty-state: помогает PM'у понять, почему projections не
    // вывелись (нет read-intent'ов / SDK упал на non-canonical α / etc).
    const readIntents: string[] = [];
    const writeIntents: string[] = [];
    for (const [iid, raw] of Object.entries(n.INTENTS ?? {})) {
      const r = raw as { α?: string; alpha?: string };
      const α = r.α ?? r.alpha;
      if (α === 'read') readIntents.push(iid);
      else if (α) writeIntents.push(iid);
    }

    return {
      // nested.INTENTS отдаём уже normalized: exec callback читает
      // `intent.particles.effects` для построения effect-row.
      nested: { ...n, INTENTS },
      mergedProjections: merged,
      artifacts: artifactsMap,
      rootProjectionIds: rootIds,
      world: foldEffects(effects),
      domainId: n.meta.id,
      description: n.meta.description,
      isEmpty: entitiesCount === 0 && intentsCount === 0,
      diagnostics: {
        entitiesCount,
        intentsCount,
        readIntents,
        writeIntents,
        entities: Object.keys(n.ONTOLOGY.entities ?? {}),
        artifactsCount: Object.keys(artifactsMap).length,
      },
      ontologyRoles,
    };
  }, [domain, effects, viewer.role]);

  // JWT role → ontology-declared role (tenant-owner маппим в admin-base).
  // Нужно чтобы SDK filterWorldForRole / renderer visibility видели знакомую
  // роль и не отсеивали всё до пустоты.
  const effectiveRole = useMemo(() => {
    if (!ontologyRoles || Object.keys(ontologyRoles).length === 0) return viewer.role;
    if (ontologyRoles[viewer.role]) return viewer.role;
    // tenant-owner fallback: ищем admin-base, затем любую первую
    for (const [rname, rdef] of Object.entries(ontologyRoles)) {
      if ((rdef as { base?: string }).base === 'admin') return rname;
    }
    return Object.keys(ontologyRoles)[0] ?? viewer.role;
  }, [ontologyRoles, viewer.role]);

  const effectiveViewer = useMemo(
    () => ({ ...viewer, role: effectiveRole }),
    [viewer, effectiveRole],
  );

  useEffect(() => {
    if (!activeProjectionId && rootProjectionIds.length > 0) {
      setActiveProjectionId(rootProjectionIds[0]);
    }
  }, [rootProjectionIds, activeProjectionId]);

  // SDK renderer вызывает exec(intentId, ctx) — runtime backend ждёт полный
  // effect-row {alpha, entity, fields, context}. buildEffectsFromIntent читает
  // intent.particles.effects (после normalize) или flat α+target и собирает
  // массив effect'ов (create обычно один, replace может дать несколько).
  const exec = useCallback(
    async (intentId: string, ctx: Record<string, unknown> = {}) => {
      const INTENTS = (nested?.INTENTS ?? {}) as Record<string, unknown>;
      const effects = buildEffectsFromIntent(intentId, ctx, INTENTS, viewer);
      if (effects.length === 0) {
        pushToast({
          kind: 'warn',
          title: `Intent «${intentId}» не сформировал effect`,
          details: 'Возможно, replace без value или неизвестный α. Проверьте онтологию.',
        });
        return;
      }
      for (const effect of effects) {
        try {
          const res = await fetch('/api/effects', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(effect),
          });
          if (res.status === 401 || res.status === 403) {
            pushToast({
              kind: 'error',
              title: 'Требуется авторизация',
              details: 'JWT cookie отсутствует или membership не выдан. Залогиньтесь повторно.',
            });
            return;
          }
          if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as {
              reason?: string;
              details?: string;
              error?: string;
            };
            const reason = err.reason ?? err.error;
            pushToast({
              kind: 'error',
              title: `Отклонено: ${humanizeReason(reason)}`,
              details: err.details,
            });
            continue;
          }
        } catch (e) {
          pushToast({
            kind: 'error',
            title: 'Сетевая ошибка',
            details: e instanceof Error ? e.message : String(e),
          });
        }
      }
      await refreshEffects();
    },
    [nested, viewer, refreshEffects, pushToast],
  );

  // Rules of Hooks: все useCallback до early-return веток. Иначе React error #310
  // (rendered more hooks than during previous render) когда domain переходит
  // из null в загруженное состояние.
  const navigate = useCallback(
    (projectionId: string, params?: Record<string, string>) => {
      if (!artifacts[projectionId]) {
        return { projectionId, params: params ?? {} };
      }
      // Push текущее в стек — для back'а. Пропускаем initial state.
      if (activeProjectionId) {
        setNavStack((s) => [...s, { pid: activeProjectionId, params: routeParams }]);
      }
      setActiveProjectionId(projectionId);
      setRouteParams(params ?? {});
      return { projectionId, params: params ?? {} };
    },
    [artifacts, activeProjectionId, routeParams],
  );

  const back = useCallback(() => {
    setNavStack((s) => {
      if (s.length === 0) return s;
      const prev = s[s.length - 1];
      setActiveProjectionId(prev.pid);
      setRouteParams(prev.params);
      return s.slice(0, -1);
    });
  }, []);

  if (error) {
    return (
      <div
        style={{
          padding: 48,
          color: 'var(--danger, #e07777)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
        }}
      >
        Ошибка: {error}
      </div>
    );
  }
  if (!domain || !nested) {
    return (
      <div
        style={{
          padding: 48,
          color: 'var(--ink-dim)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
        }}
      >
        Загрузка…
      </div>
    );
  }

  const activeArtifact = activeProjectionId ? artifacts[activeProjectionId] : null;
  const activeProjection = activeProjectionId ? mergedProjections[activeProjectionId] : null;

  return (
    <AntdAdapterProvider>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          <header
            style={{
              padding: '14px 32px',
              borderBottom: '1px solid #e5e7eb',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11.5,
              letterSpacing: '0.04em',
              color: '#6b7280',
              background: '#fafafa',
            }}
          >
            <strong style={{ color: '#111', letterSpacing: '0.08em' }}>IDF APP</strong>
            <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span>{domainId}</span>
              <span
                style={{
                  padding: '2px 8px',
                  border: '1px solid #d1d5db',
                  borderRadius: 10,
                  background: '#f3f4f6',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10.5,
                  letterSpacing: '0.04em',
                  color: '#374151',
                }}
                title={
                  effectiveRole !== viewer.role
                    ? `JWT membership: ${viewer.role} → отображается как ${effectiveRole} (этой роли нет в ontology.roles, используется admin-base fallback)`
                    : 'Текущая роль (из JWT membership)'
                }
              >
                вы: {viewer.role}
                {effectiveRole !== viewer.role && (
                  <span style={{ color: '#9ca3af', marginLeft: 6 }}>→ {effectiveRole}</span>
                )}
              </span>
            </span>
          </header>

          {isEmpty ? (
            <EmptyDomain description={description} />
          ) : rootProjectionIds.length === 0 ? (
            <NoProjections domainId={domainId} description={description} diagnostics={diagnostics} />
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0 }}>
              <nav
                style={{
                  width: 240,
                  borderRight: '1px solid #e5e7eb',
                  padding: '16px 12px',
                  overflowY: 'auto',
                  background: '#fafafa',
                }}
              >
                <div
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10.5,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: '#9ca3af',
                    marginBottom: 10,
                    padding: '0 8px',
                  }}
                >
                  Разделы
                </div>
                {rootProjectionIds.map((pid) => {
                  const proj = mergedProjections[pid];
                  const art = artifacts[pid];
                  const isActive = pid === activeProjectionId;
                  // Приоритет: authored name → artifact title → mainEntity
                  // (CapitalCase) → humanized pid. До fix'а humanizeId давал
                  // lowercase «book» для book_list и book_detail одновременно
                  // — дубли в sidebar было не отличить.
                  const label =
                    proj?.name ??
                    art?.title ??
                    (art?.mainEntity as string | undefined) ??
                    humanizeId(pid);
                  return (
                    <button
                      key={pid}
                      onClick={() => {
                        // Top-level nav click — сбрасываем routeParams и стек,
                        // иначе при возврате на catalog через sidebar detail
                        // всё ещё видит старый id.
                        setActiveProjectionId(pid);
                        setRouteParams({});
                        setNavStack([]);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        marginBottom: 2,
                        border: 'none',
                        borderRadius: 4,
                        background: isActive ? '#1677ff' : 'transparent',
                        color: isActive ? '#fff' : '#111',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontFamily: 'Inter, system-ui, sans-serif',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </nav>
              <main style={{ flex: 1, overflow: 'auto', padding: 24, background: '#fff' }}>
                {navStack.length > 0 && (
                  <button
                    onClick={back}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 8px',
                      marginBottom: 16,
                      border: '1px solid #e5e7eb',
                      borderRadius: 4,
                      background: '#fafafa',
                      color: '#374151',
                      fontSize: 12,
                      fontFamily: 'JetBrains Mono, monospace',
                      cursor: 'pointer',
                    }}
                  >
                    ← Назад
                  </button>
                )}
                {activeArtifact ? (
                  <RendererBoundary pid={activeProjectionId ?? 'unknown'}>
                    <ProjectionRendererV2
                      artifact={activeArtifact}
                      projection={activeProjection}
                      artifacts={artifacts}
                      allProjections={mergedProjections}
                      world={world}
                      viewer={effectiveViewer}
                      viewerContext={{ userId: viewer.id, userName: viewer.name }}
                      exec={exec}
                      routeParams={routeParams}
                      navigate={navigate}
                      back={back}
                    />
                  </RendererBoundary>
                ) : (
                  <div style={{ color: '#6b7280' }}>Выберите раздел слева</div>
                )}
              </main>
            </div>
        )}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </AntdAdapterProvider>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        zIndex: 1000,
        maxWidth: 420,
      }}
    >
      {toasts.map((t) => {
        const borderColor =
          t.kind === 'error' ? '#dc2626' : t.kind === 'warn' ? '#d97706' : '#1677ff';
        return (
          <div
            key={t.id}
            onClick={() => onDismiss(t.id)}
            style={{
              padding: '12px 14px',
              background: '#fff',
              border: `1px solid ${borderColor}`,
              borderLeft: `4px solid ${borderColor}`,
              borderRadius: 4,
              boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
              cursor: 'pointer',
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 13,
              color: '#111',
              lineHeight: 1.45,
            }}
            title="Click to dismiss"
          >
            <div style={{ fontWeight: 600, marginBottom: t.details ? 4 : 0 }}>{t.title}</div>
            {t.details && (
              <div style={{ color: '#6b7280', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
                {t.details}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyDomain({ description }: { description?: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <div style={{ textAlign: 'center', maxWidth: 620 }}>
        <div
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: '#1677ff',
            marginBottom: 14,
          }}
        >
          Приложение создаётся
        </div>
        <h1 style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, fontSize: '2rem', marginBottom: 12 }}>
          Домен пока пустой
        </h1>
        <p style={{ color: '#6b7280', fontSize: 15, lineHeight: 1.55 }}>
          {description ??
            'Владелец проекта ещё не опубликовал онтологию. После нажатия «Опубликовать» в IDF Studio — здесь появится приложение.'}
        </p>
      </div>
    </div>
  );
}

/**
 * ErrorBoundary вокруг ProjectionRendererV2. Renderer может бросить на любой
 * ontology-malformation (например incomplete compositions, unexpected field
 * shape). До boundary это было blank-screen — теперь PM видит error + stack
 * + название projection'а, что ускоряет debug.
 *
 * Reset при смене pid через key={pid} на boundary'е.
 */
type RendererBoundaryState = { error: Error | null; info: ErrorInfo | null };
class RendererBoundary extends Component<{ pid: string; children: ReactNode }, RendererBoundaryState> {
  state: RendererBoundaryState = { error: null, info: null };
  static getDerivedStateFromError(error: Error): RendererBoundaryState {
    return { error, info: null };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RendererBoundary]', this.props.pid, error, info);
    this.setState({ error, info });
  }
  componentDidUpdate(prev: { pid: string }) {
    if (prev.pid !== this.props.pid && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            border: '1px solid #fecaca',
            borderRadius: 8,
            background: '#fef2f2',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            lineHeight: 1.6,
            color: '#991b1b',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
            Renderer упал на projection <code>{this.props.pid}</code>
          </div>
          <div style={{ color: '#7f1d1d', marginBottom: 10 }}>{this.state.error.message}</div>
          {this.state.info?.componentStack && (
            <pre
              style={{
                fontSize: 10.5,
                color: '#9f1239',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
                maxHeight: 200,
                overflow: 'auto',
              }}
            >
              {this.state.info.componentStack}
            </pre>
          )}
          <div style={{ marginTop: 12, color: '#6b7280', fontSize: 11 }}>
            Откройте DevTools Console для полного stack trace.
          </div>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

function NoProjections({
  domainId,
  description,
  diagnostics,
}: {
  domainId: string;
  description?: string;
  diagnostics?: {
    entitiesCount: number;
    intentsCount: number;
    readIntents: string[];
    writeIntents: string[];
    entities: string[];
    artifactsCount: number;
  };
}) {
  return (
    <div style={{ flex: 1, padding: 48, maxWidth: 720, margin: '0 auto' }}>
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#1677ff',
          marginBottom: 14,
        }}
      >
        Онтология опубликована
      </div>
      <h1 style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, fontSize: '2rem', marginBottom: 12 }}>{domainId}</h1>
      {description && <p style={{ color: '#6b7280', fontSize: 15, lineHeight: 1.55 }}>{description}</p>}
      <p style={{ color: '#6b7280', fontSize: 14, marginTop: 20 }}>
        Проекции ещё не выведены. Вероятные причины ниже.
      </p>

      {diagnostics && (
        <div
          style={{
            marginTop: 24,
            padding: 20,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            background: '#fafafa',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            lineHeight: 1.7,
            color: '#374151',
          }}
        >
          <div style={{ fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 12 }}>
            Диагностика
          </div>
          <div>Сущности: <strong>{diagnostics.entitiesCount}</strong> ({diagnostics.entities.join(', ') || '—'})</div>
          <div>Intent'ов: <strong>{diagnostics.intentsCount}</strong></div>
          <div>
            &nbsp;&nbsp;read: {diagnostics.readIntents.length > 0 ? diagnostics.readIntents.join(', ') : <span style={{ color: '#dc2626' }}>нет (нужен минимум один list_*)</span>}
          </div>
          <div>&nbsp;&nbsp;write: {diagnostics.writeIntents.length}</div>
          <div>
            Artifacts (после crystallizeV2): <strong style={{ color: diagnostics.artifactsCount === 0 ? '#dc2626' : '#16a34a' }}>{diagnostics.artifactsCount}</strong>
          </div>
          {diagnostics.readIntents.length === 0 ? (
            <div style={{ marginTop: 14, padding: 10, background: '#fef3c7', borderRadius: 4, color: '#92400e' }}>
              Нет <code>α: "read"</code> intent'ов → <code>deriveProjections</code> возвращает пусто. Попроси Claude
              добавить <code>list_&lt;entity&gt;</code> для каждой сущности.
            </div>
          ) : diagnostics.artifactsCount === 0 ? (
            <div style={{ marginTop: 14, padding: 10, background: '#fef3c7', borderRadius: 4, color: '#92400e' }}>
              Read-intent'ы есть, но artifacts = 0. Проверь консоль — возможно <code>crystallizeV2</code> упал
              на non-canonical <code>α</code> (update/add/delete — coerce'нуто в runtime, но SDK-внутри мог не справиться).
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
