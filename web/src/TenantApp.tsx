import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ProjectionRendererV2,
  registerUIAdapter,
  AdapterProvider,
} from '@intent-driven/renderer';
import {
  crystallizeV2,
  deriveProjections,
} from '@intent-driven/core';
import { mantineAdapter } from '@intent-driven/adapter-mantine';
import '@intent-driven/adapter-mantine/styles.css';

// Mantine adapter used как default — CRUD forms, списки, chart primitive.
registerUIAdapter(mantineAdapter);

// Domain shape как Runtime хранит (flat) vs как SDK ожидает (nested ONTOLOGY).
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

/** Flat → nested shape для совместимости с SDK crystallize_v2. */
function toNested(flat: FlatDomain): NestedDomain {
  return {
    meta: { id: flat.meta?.id ?? 'tenant', description: flat.meta?.description },
    INTENTS: flat.intents ?? {},
    PROJECTIONS: flat.projections ?? {},
    ONTOLOGY: {
      entities: flat.entities ?? {},
      roles: flat.roles ?? {},
      invariants: flat.invariants ?? [],
    },
    DOMAIN_NAME: flat.meta?.id,
  };
}

/** Runtime effect log → world snapshot: `{entity → {id → row}}`. */
function foldEffects(effects: Array<{ alpha: string; entity: string; fields: Record<string, unknown> }>): Record<string, Record<string, Record<string, unknown>>> {
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

type EffectRow = {
  id?: string;
  alpha: string;
  entity: string;
  fields: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export function TenantApp() {
  const [domain, setDomain] = useState<FlatDomain | null>(null);
  const [effects, setEffects] = useState<EffectRow[]>([]);
  const [activeProjectionId, setActiveProjectionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer] = useState({ id: 'tenant-viewer', name: 'Tenant', role: 'owner' });

  const refreshEffects = useCallback(async () => {
    try {
      const res = await fetch('/api/effects', { credentials: 'include' });
      if (!res.ok) {
        // 401/403 — auth-required; degrade gracefully, показываем пустой world
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

  const nested = useMemo(() => (domain ? toNested(domain) : null), [domain]);

  /** Derived + authored projections (authored have priority). */
  const allProjections = useMemo(() => {
    if (!nested) return {};
    try {
      const derived = deriveProjections(nested.INTENTS, nested.ONTOLOGY);
      return { ...derived, ...(nested.PROJECTIONS ?? {}) };
    } catch (e) {
      console.warn('deriveProjections failed:', e);
      return nested.PROJECTIONS ?? {};
    }
  }, [nested]);

  /** Root projections для nav — кроме absorbed by hub. */
  const rootProjections = useMemo(() => {
    const list: Array<{ id: string; projection: Record<string, unknown> }> = [];
    for (const [id, p] of Object.entries(allProjections)) {
      const proj = p as Record<string, unknown>;
      if (proj.absorbedBy) continue;
      list.push({ id, projection: { id, ...proj } });
    }
    return list;
  }, [allProjections]);

  // Auto-select first projection
  useEffect(() => {
    if (activeProjectionId) return;
    if (rootProjections.length > 0) {
      setActiveProjectionId(rootProjections[0].id);
    }
  }, [rootProjections, activeProjectionId]);

  const world = useMemo(() => foldEffects(effects), [effects]);

  const exec = useCallback(
    async (effect: EffectRow) => {
      try {
        const res = await fetch('/api/effects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(effect),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`exec ${res.status}: ${body.slice(0, 120)}`);
        }
        await refreshEffects();
      } catch (e) {
        console.error('exec failed:', e);
        throw e;
      }
    },
    [refreshEffects],
  );

  const execBatch = useCallback(
    async (batch: EffectRow[]) => {
      for (const e of batch) await exec(e);
    },
    [exec],
  );

  const activeProjection = useMemo(() => {
    if (!activeProjectionId) return null;
    const p = allProjections[activeProjectionId] as Record<string, unknown> | undefined;
    if (!p) return null;
    return { id: activeProjectionId, ...p };
  }, [activeProjectionId, allProjections]);

  const artifact = useMemo(() => {
    if (!nested || !activeProjection) return null;
    try {
      return crystallizeV2(
        nested.INTENTS,
        nested.ONTOLOGY,
        activeProjection,
        { viewer, allProjections },
      );
    } catch (e) {
      console.warn('crystallize failed:', e);
      return null;
    }
  }, [nested, activeProjection, viewer, allProjections]);

  if (error) {
    return (
      <div style={{ padding: 48, color: 'var(--danger, #e07777)' }}>
        Ошибка загрузки домена: {error}
      </div>
    );
  }
  if (!domain || !nested) {
    return (
      <div style={{ padding: 48, color: 'var(--ink-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
        Загрузка…
      </div>
    );
  }
  if (rootProjections.length === 0) {
    return (
      <div style={{ padding: '80px 48px', maxWidth: 720, margin: '0 auto' }}>
        <div style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 14 }}>
          Приложение создаётся
        </div>
        <h1 style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, fontSize: '2.4rem', marginBottom: 12, color: 'var(--ink)' }}>
          {nested.meta.id}
        </h1>
        <p style={{ color: 'var(--ink-dim)', fontSize: 15, lineHeight: 1.55 }}>
          Онтология домена опубликована, но проекции ещё не сгенерированы.
          Владелец проекта в IDF Studio нажмёт «Опубликовать» ещё раз —
          проекции будут derived из intents и entities автоматически.
        </p>
      </div>
    );
  }

  return (
    <AdapterProvider adapter={mantineAdapter}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {/* Top bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '10px 24px',
            borderBottom: '1px solid var(--rule)',
            background: 'var(--paper-dim)',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 13,
          }}
        >
          <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 600, fontSize: 15 }}>
            {nested.meta.id}
          </div>
          {nested.meta.description && (
            <div style={{ color: 'var(--ink-dim)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nested.meta.description}
            </div>
          )}
          <div style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-mid)', letterSpacing: '0.04em' }}>
            {viewer.name} · {viewer.role}
          </div>
        </div>

        {/* Projection tabs */}
        <div
          style={{
            display: 'flex',
            gap: 2,
            padding: '4px 16px',
            borderBottom: '1px solid var(--rule)',
            background: 'var(--paper)',
            overflowX: 'auto',
          }}
        >
          {rootProjections.map(({ id, projection }) => (
            <button
              key={id}
              onClick={() => setActiveProjectionId(id)}
              style={{
                padding: '6px 12px',
                border: 'none',
                borderRadius: 4,
                background: activeProjectionId === id ? 'var(--accent-bg)' : 'transparent',
                color: activeProjectionId === id ? 'var(--accent)' : 'var(--ink-dim)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11.5,
                letterSpacing: '0.04em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title={`${(projection as { archetype?: string }).archetype ?? ''}/${id}`}
            >
              {id}
            </button>
          ))}
        </div>

        {/* Content — active projection */}
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {artifact && activeProjection ? (
            <ProjectionRendererV2
              artifact={artifact}
              artifactOverride={null}
              previewPatternId={null}
              onExpandPattern={() => {}}
              activeView={null}
              projection={activeProjection}
              world={world}
              exec={exec}
              execBatch={execBatch}
              viewer={viewer}
              viewerContext={{}}
              routeParams={{}}
              navigate={(pid: string) => setActiveProjectionId(pid)}
              back={() => {}}
              theme="dark"
              artifacts={{}}
              allProjections={allProjections}
            />
          ) : (
            <div style={{ color: 'var(--ink-dim)' }}>
              Не удалось crystallize'нуть проекцию «{activeProjectionId}». Проверь
              структуру onтологии (entities должны быть референсированы в intents'ах).
            </div>
          )}
        </div>
      </div>
    </AdapterProvider>
  );
}
