import { useEffect, useMemo, useState } from 'react';

/**
 * Simple React tenant overview — structured view of deployed ontology.
 *
 * Не использует SDK ProjectionRendererV2 + Mantine adapter (peer-dep конфликт
 * mantine@9 ↔ react@19 vs react@18 + ряд missing peer deps через npm
 * legacy-peer-deps). Полноценный V2Shell rendering — следующий milestone
 * после stabilization frontend dep-graph'а.
 *
 * Текущее поведение: fetch /api/domain → render entities/intents/roles в
 * editorial dark stele. Аналогично раннему vanilla tenant-index.html, но
 * React-интерактивный (tabs, refresh, ready для postMessage extensions).
 */

type FlatDomain = {
  meta?: { id?: string; description?: string };
  entities?: Record<string, Entity>;
  intents?: Record<string, Intent>;
  roles?: Record<string, Role>;
  invariants?: unknown[];
  projections?: Record<string, unknown>;
};

type Entity = {
  fields?: Record<string, FieldSpec>;
  [k: string]: unknown;
};

type FieldSpec = {
  type?: string;
  required?: boolean;
  [k: string]: unknown;
};

type Intent = {
  α?: string;
  alpha?: string;
  target?: string;
  [k: string]: unknown;
};

type Role = {
  base?: string;
  canExecute?: string[];
  [k: string]: unknown;
};

type Tab = 'entities' | 'intents' | 'roles' | 'api';

const TAB_LABELS: Record<Tab, string> = {
  entities: 'Сущности',
  intents: 'Действия',
  roles: 'Роли',
  api: 'API',
};

export function TenantApp() {
  const [domain, setDomain] = useState<FlatDomain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('entities');

  useEffect(() => {
    fetch('/api/domain')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`domain ${r.status}`))))
      .then((d: FlatDomain) => setDomain(d))
      .catch((e) => setError(e.message));
  }, []);

  const counts = useMemo(() => {
    if (!domain) return { entities: 0, intents: 0, roles: 0, projections: 0 };
    return {
      entities: Object.keys(domain.entities ?? {}).length,
      intents: Object.keys(domain.intents ?? {}).length,
      roles: Object.keys(domain.roles ?? {}).length,
      projections: Object.keys(domain.projections ?? {}).length,
    };
  }, [domain]);

  if (error) {
    return (
      <div style={{ padding: 48, color: 'var(--danger, #e07777)', fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
        Ошибка: {error}
      </div>
    );
  }
  if (!domain) {
    return (
      <div style={{ padding: 48, color: 'var(--ink-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
        Загрузка…
      </div>
    );
  }

  const domainId = domain.meta?.id ?? 'tenant';
  const isEmpty = counts.entities === 0 && counts.intents === 0 && counts.roles === 0;

  if (isEmpty) {
    return (
      <Shell domainId={domainId} description={domain.meta?.description}>
        <div style={{ padding: '80px 48px', maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 14 }}>
            Приложение создаётся
          </div>
          <h2 style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, fontSize: '1.5rem', marginBottom: 12 }}>
            Онтология пока пустая
          </h2>
          <p style={{ color: 'var(--ink-dim)', fontSize: 14, lineHeight: 1.55 }}>
            Владелец проекта ещё не опубликовал entities/intents. После нажатия «Опубликовать»
            в IDF Studio — здесь появится структура приложения.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell domainId={domainId} description={domain.meta?.description}>
      {/* Counter cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          borderTop: '1px solid var(--rule)',
          borderLeft: '1px solid var(--rule)',
          marginTop: 24,
        }}
      >
        <Card label="Сущности" value={counts.entities} />
        <Card label="Действия" value={counts.intents} />
        <Card label="Роли" value={counts.roles} />
        <Card label="Проекции" value={counts.projections} />
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          marginTop: 36,
          marginBottom: 20,
          borderBottom: '1px solid var(--rule)',
          paddingBottom: 0,
        }}
      >
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom: `2px solid ${tab === t ? 'var(--accent)' : 'transparent'}`,
              background: 'transparent',
              color: tab === t ? 'var(--accent)' : 'var(--ink-dim)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div style={{ minHeight: 300 }}>
        {tab === 'entities' && <EntitiesView entities={domain.entities ?? {}} />}
        {tab === 'intents' && <IntentsView intents={domain.intents ?? {}} />}
        {tab === 'roles' && <RolesView roles={domain.roles ?? {}} />}
        {tab === 'api' && (
          <ApiView
            domainId={domainId}
            projectionIds={Object.keys(domain.projections ?? {})}
          />
        )}
      </div>
    </Shell>
  );
}

function Shell({
  domainId,
  description,
  children,
}: {
  domainId: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '18px 48px',
          borderBottom: '1px solid var(--rule)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 18,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          letterSpacing: '0.04em',
          color: 'var(--ink-dim)',
          background: 'var(--paper-dim)',
        }}
      >
        <strong style={{ color: 'var(--ink)', letterSpacing: '0.08em' }}>IDF APP</strong>
        <code style={{ color: 'var(--ink)' }}>{domainId}</code>
        {description && (
          <span style={{ color: 'var(--ink-dim)', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>
            {description}
          </span>
        )}
      </header>
      <main
        style={{
          flex: 1,
          maxWidth: 1100,
          width: '100%',
          margin: '0 auto',
          padding: '48px 48px 120px',
        }}
      >
        {children}
      </main>
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: '22px 24px',
        borderRight: '1px solid var(--rule)',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10.5,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--ink-mid)',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'Fraunces, serif',
          fontWeight: 600,
          fontSize: '2rem',
          color: value > 0 ? 'var(--ink)' : 'var(--ink-mid)',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function EntitiesView({ entities }: { entities: Record<string, Entity> }) {
  const items = Object.entries(entities);
  if (items.length === 0) return <EmptyHint label="Сущностей пока нет" />;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
      {items.map(([name, entity]) => {
        const fields = Object.entries(entity.fields ?? {});
        return (
          <div
            key={name}
            style={{
              padding: '16px 18px',
              background: 'var(--paper-dim)',
              border: '1px solid var(--rule)',
              borderRadius: 6,
            }}
          >
            <div
              style={{
                fontFamily: 'Fraunces, serif',
                fontWeight: 600,
                fontSize: 17,
                color: 'var(--ink)',
                marginBottom: 4,
              }}
            >
              {name}
            </div>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10.5,
                color: 'var(--ink-mid)',
                letterSpacing: '0.06em',
                marginBottom: 12,
              }}
            >
              {fields.length} ПОЛЕЙ
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {fields.map(([fieldName, spec]) => (
                <li
                  key={fieldName}
                  style={{
                    padding: '3px 0',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    color: 'var(--ink-dim)',
                  }}
                >
                  <span style={{ color: 'var(--ink)' }}>{fieldName}</span>
                  <span>: </span>
                  <span style={{ color: 'var(--accent)' }}>
                    {typeof spec === 'object' && spec && spec.type ? spec.type : JSON.stringify(spec)}
                  </span>
                  {spec?.required && (
                    <span style={{ color: 'var(--ok, #6fbf7f)', marginLeft: 6, fontSize: 10 }}>req</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function IntentsView({ intents }: { intents: Record<string, Intent> }) {
  const items = Object.entries(intents);
  if (items.length === 0) return <EmptyHint label="Действий пока нет" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(([id, intent]) => (
        <div
          key={id}
          style={{
            padding: '10px 14px',
            background: 'var(--paper-dim)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
          }}
        >
          <span style={{ color: 'var(--ink)' }}>{id}</span>
          <span style={{ color: 'var(--ink-mid)' }}> · α=</span>
          <span style={{ color: 'var(--accent)' }}>{intent.α ?? intent.alpha ?? '?'}</span>
          {intent.target && (
            <>
              <span style={{ color: 'var(--ink-mid)' }}> → </span>
              <span style={{ color: 'var(--ink)' }}>{intent.target}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function RolesView({ roles }: { roles: Record<string, Role> }) {
  const items = Object.entries(roles);
  if (items.length === 0) return <EmptyHint label="Ролей пока нет" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map(([name, role]) => {
        const can = role.canExecute ?? [];
        return (
          <div
            key={name}
            style={{
              padding: '14px 18px',
              background: 'var(--paper-dim)',
              border: '1px solid var(--rule)',
              borderRadius: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
              <span style={{ fontFamily: 'Fraunces, serif', fontWeight: 600, fontSize: 15 }}>
                {name}
              </span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--ink-mid)', fontSize: 11 }}>
                base=
              </span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)', fontSize: 12 }}>
                {role.base ?? '?'}
              </span>
            </div>
            {can.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                Может: {can.join(', ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ApiView({ domainId, projectionIds }: { domainId: string; projectionIds: string[] }) {
  const endpoints: Array<{ method: string; path: string; description: string }> = [
    { method: 'GET', path: '/health', description: 'Проверка работоспособности tenant runtime' },
    { method: 'GET', path: '/api/domain', description: 'Текущая ontology (public, без user-данных)' },
    {
      method: 'POST',
      path: `/api/agent/${domainId}/exec`,
      description: 'Агентский exec (JWT + agent-роль)',
    },
    {
      method: 'POST',
      path: `/api/agent/${domainId}/preapproval`,
      description: 'Preapproval лимиты для agent-роли',
    },
  ];
  for (const pid of projectionIds.slice(0, 6)) {
    endpoints.push({
      method: 'GET',
      path: `/api/document/${pid}?format=html|json`,
      description: `Document-материализация «${pid}»`,
    });
    endpoints.push({
      method: 'GET',
      path: `/api/voice/${pid}?format=plain|ssml`,
      description: `Voice-скрипт «${pid}»`,
    });
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {endpoints.map((e) => (
        <div
          key={e.method + e.path}
          style={{
            padding: '10px 14px',
            background: 'var(--paper-dim)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--accent)', fontWeight: 600, minWidth: 40 }}>{e.method}</span>
          <span style={{ color: 'var(--ink)' }}>{e.path}</span>
          <span style={{ color: 'var(--ink-dim)', fontFamily: 'Inter, sans-serif', fontSize: 12, marginLeft: 'auto' }}>
            {e.description}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div
      style={{
        color: 'var(--ink-mid)',
        textAlign: 'center',
        marginTop: 60,
        fontFamily: 'Fraunces, serif',
        fontStyle: 'italic',
        fontSize: 15,
      }}
    >
      {label}
    </div>
  );
}
