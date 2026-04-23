import { useCallback, useEffect, useMemo, useState } from 'react';
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
 * Очищает entity.fields от null-значений. Studio `mergePatch` мержит
 * patches поверх existing domain — если Claude прислал `{fields: {x: null}}`
 * (намерение удалить) или автосинк снёс поле после revision'а, null кладётся
 * в fields и ломает SDK `detectForeignKeys` (он ждёт object с .type).
 * Deep-clean перед crystallize, аналогично studio preview sanitizeEntities.
 */
function sanitizeEntities(
  entities: Record<string, unknown>,
): Record<string, { fields: Record<string, unknown>; [k: string]: unknown }> {
  const out: Record<string, { fields: Record<string, unknown>; [k: string]: unknown }> = {};
  for (const [name, entity] of Object.entries(entities ?? {})) {
    if (!entity || typeof entity !== 'object') continue;
    const src = entity as { fields?: Record<string, unknown>; [k: string]: unknown };
    const fields: Record<string, unknown> = {};
    for (const [fname, fspec] of Object.entries(src.fields ?? {})) {
      if (fspec && typeof fspec === 'object') fields[fname] = fspec;
      // null / undefined / primitives — пропускаем
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

function humanizeReason(reason: string | undefined): string {
  if (!reason) return 'Отклонено';
  return REASON_LABELS[reason] ?? reason;
}

function foldEffects(effects: EffectRow[]): Record<string, Record<string, Record<string, unknown>>> {
  const world: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const e of effects) {
    const id = e.fields?.id as string | undefined;
    if (!id) continue;
    if (!world[e.entity]) world[e.entity] = {};
    if (e.alpha === 'create') {
      world[e.entity][id] = { ...e.fields };
    } else if (e.alpha === 'replace') {
      world[e.entity][id] = { ...(world[e.entity][id] ?? {}), ...e.fields };
    } else if (e.alpha === 'remove') {
      delete world[e.entity][id];
    }
  }
  return world;
}

export function TenantApp() {
  const [domain, setDomain] = useState<FlatDomain | null>(null);
  const [effects, setEffects] = useState<EffectRow[]>([]);
  const [activeProjectionId, setActiveProjectionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer] = useState({ id: 'tenant-viewer', name: 'Tenant', role: 'owner' });
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
  } = useMemo(() => {
    const emptyReturn = {
      nested: null,
      mergedProjections: {} as Record<string, any>,
      artifacts: {} as Record<string, any>,
      rootProjectionIds: [] as string[],
      world: {} as Record<string, Record<string, Record<string, unknown>>>,
      domainId: 'tenant',
      description: undefined as string | undefined,
      isEmpty: true,
    };
    if (!domain) return emptyReturn;

    const n = toNested(domain);

    // normalizeIntentsMap обязателен: template'ы / importer-output хранят
    // intents в flat-форме `{α, target, parameters}` без `particles.effects` и
    // `creates`. Без normalize analyzeIntents не находит creators/mutators —
    // результат: rootProjectionIds = [] и NoProjections stub вместо UI.
    const INTENTS = normalizeIntentsMap(n.INTENTS as Record<string, unknown>) as Record<string, any>;

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

    // Root projections = artifact'ы не absorbedBy другим (R8 hub-absorption).
    const rootIds = Object.keys(artifactsMap).filter((pid) => !artifactsMap[pid]?.absorbedBy);

    const entitiesCount = Object.keys(n.ONTOLOGY.entities ?? {}).length;
    const intentsCount = Object.keys(n.INTENTS ?? {}).length;
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
    };
  }, [domain, effects]);

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
      if (artifacts[projectionId]) {
        setActiveProjectionId(projectionId);
      }
      return { projectionId, params: params ?? {} };
    },
    [artifacts],
  );
  const back = useCallback(() => undefined, []);

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
            <span>{domainId}</span>
          </header>

          {isEmpty ? (
            <EmptyDomain description={description} />
          ) : rootProjectionIds.length === 0 ? (
            <NoProjections domainId={domainId} description={description} />
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
                  const label = proj?.name ?? art?.title ?? humanizeId(pid);
                  return (
                    <button
                      key={pid}
                      onClick={() => setActiveProjectionId(pid)}
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
                {activeArtifact ? (
                  <ProjectionRendererV2
                    artifact={activeArtifact}
                    projection={activeProjection}
                    artifacts={artifacts}
                    allProjections={mergedProjections}
                    world={world}
                    viewer={viewer}
                    viewerContext={{ userId: viewer.id, userName: viewer.name }}
                    exec={exec}
                    routeParams={{}}
                    navigate={navigate}
                    back={back}
                  />
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

function NoProjections({ domainId, description }: { domainId: string; description?: string }) {
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
        Проекции ещё не выведены. Добавьте сущности и действия в IDF Studio — SDK автоматически сгенерирует экраны.
      </p>
    </div>
  );
}
