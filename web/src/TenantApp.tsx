import { useEffect, useMemo, useState } from 'react';

/**
 * Tenant overview report — "first-view" layout:
 * eyebrow + большой serif domain-id + description lede, 4-cell grid счётчиков,
 * ниже секции с entity-карточками, intent-list, role-list, API-endpoints.
 * Всё на один scroll, без tabs.
 *
 * Матчит UX что PM видел сразу после нажатия «Опубликовать» в studio —
 * structured report приложения. Полноценный interactive V2Shell — следующий
 * milestone (требует stabilization peer-dep graph'а react/mantine/sdk).
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

export function TenantApp() {
  const [domain, setDomain] = useState<FlatDomain | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/domain')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`domain ${r.status}`))))
      .then((d: FlatDomain) => setDomain(d))
      .catch((e) => setError(e.message));
  }, []);

  const counts = useMemo(() => {
    if (!domain) return { entities: 0, intents: 0, roles: 0, invariants: 0, projections: 0 };
    return {
      entities: Object.keys(domain.entities ?? {}).length,
      intents: Object.keys(domain.intents ?? {}).length,
      roles: Object.keys(domain.roles ?? {}).length,
      invariants: (domain.invariants ?? []).length,
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
  const description = domain.meta?.description;
  const entities = domain.entities ?? {};
  const intents = domain.intents ?? {};
  const roles = domain.roles ?? {};
  const projectionIds = Object.keys(domain.projections ?? {});
  const entityNames = Object.keys(entities);
  const intentIds = Object.keys(intents);
  const roleIds = Object.keys(roles);
  const isEmpty = entityNames.length === 0 && intentIds.length === 0 && roleIds.length === 0;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '18px 48px',
          borderBottom: '1px solid var(--rule)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          letterSpacing: '0.04em',
          color: 'var(--ink-dim)',
          background: 'var(--paper-dim)',
        }}
      >
        <strong style={{ color: 'var(--ink)', letterSpacing: '0.08em' }}>IDF APP</strong>
        <span>{domainId}</span>
      </header>

      <main style={{ flex: 1, maxWidth: 1100, width: '100%', margin: '0 auto', padding: '56px 48px 120px' }}>
        {isEmpty ? (
          <div style={{ textAlign: 'center', marginTop: 60 }}>
            <div style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 14 }}>
              Приложение создаётся
            </div>
            <h1 style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, fontSize: '2rem', marginBottom: 12 }}>
              Домен пока пустой
            </h1>
            <p style={{ color: 'var(--ink-dim)', fontSize: 15, lineHeight: 1.55, maxWidth: 620, margin: '0 auto' }}>
              Владелец проекта ещё не опубликовал онтологию. После нажатия «Опубликовать»
              в IDF Studio — здесь появится структура приложения.
            </p>
          </div>
        ) : (
          <>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                marginBottom: 14,
              }}
            >
              Приложение готово
            </div>
            <h1
              style={{
                fontFamily: 'Fraunces, serif',
                fontWeight: 500,
                fontSize: 'clamp(2.2rem, 5vw, 3.5rem)',
                lineHeight: 1.02,
                letterSpacing: '-0.02em',
                marginBottom: description ? 18 : 36,
                wordBreak: 'break-all',
              }}
            >
              {domainId}
            </h1>
            {description && (
              <p style={{ color: 'var(--ink-dim)', fontSize: 15, lineHeight: 1.55, marginBottom: 36, maxWidth: 720 }}>
                {description}
              </p>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                borderTop: '1px solid var(--rule)',
                borderLeft: '1px solid var(--rule)',
                marginBottom: 48,
              }}
            >
              <CounterCard label="Сущности" value={counts.entities} preview={entityNames.slice(0, 6)} />
              <CounterCard label="Действия" value={counts.intents} preview={intentIds.slice(0, 6)} />
              <CounterCard label="Роли" value={counts.roles} preview={roleIds.slice(0, 6)} />
              <CounterCard
                label="Инварианты"
                value={counts.invariants}
                preview={counts.projections > 0 ? [`${counts.projections} проекций`] : []}
                previewColor={counts.projections > 0 ? 'var(--ink-mid)' : undefined}
              />
            </div>

            {entityNames.length > 0 && (
              <Section label="Схема" title="Сущности">
                {entityNames.map((name) => {
                  const fields = Object.entries(entities[name]?.fields ?? {});
                  return (
                    <div
                      key={name}
                      style={{
                        marginBottom: 12,
                        padding: 16,
                        background: 'var(--paper-dim)',
                        border: '1px solid var(--rule)',
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 600, fontSize: 16, color: 'var(--ink)', marginBottom: 4 }}>
                        {name}
                      </div>
                      <div
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 10.5,
                          color: 'var(--ink-mid)',
                          letterSpacing: '0.06em',
                          marginBottom: 10,
                        }}
                      >
                        {fields.length} ПОЛЕЙ
                      </div>
                      <ul
                        style={{
                          listStyle: 'none',
                          padding: 0,
                          margin: 0,
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                          gap: '4px 16px',
                        }}
                      >
                        {fields.map(([fn, fv]) => (
                          <li
                            key={fn}
                            style={{
                              padding: '2px 0',
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 12,
                              color: 'var(--ink-dim)',
                            }}
                          >
                            <span style={{ color: 'var(--ink)' }}>{fn}</span>
                            <span>: </span>
                            <span style={{ color: 'var(--accent)' }}>
                              {typeof fv === 'object' && fv && fv.type ? fv.type : JSON.stringify(fv)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </Section>
            )}

            {intentIds.length > 0 && (
              <Section label="Операции" title="Действия">
                {intentIds.map((id) => {
                  const i = intents[id];
                  return (
                    <div
                      key={id}
                      style={{
                        padding: '8px 12px',
                        background: 'var(--paper-dim)',
                        border: '1px solid var(--rule)',
                        borderRadius: 4,
                        marginBottom: 6,
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 12.5,
                      }}
                    >
                      <span style={{ color: 'var(--ink)' }}>{id}</span>
                      <span style={{ color: 'var(--ink-mid)' }}> · α=</span>
                      <span style={{ color: 'var(--accent)' }}>{i.α ?? i.alpha ?? '?'}</span>
                      {i.target && (
                        <>
                          <span style={{ color: 'var(--ink-mid)' }}> → </span>
                          <span style={{ color: 'var(--ink)' }}>{i.target}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </Section>
            )}

            {roleIds.length > 0 && (
              <Section label="Доступ" title="Роли">
                {roleIds.map((r) => {
                  const role = roles[r];
                  return (
                    <div
                      key={r}
                      style={{
                        padding: '8px 12px',
                        background: 'var(--paper-dim)',
                        border: '1px solid var(--rule)',
                        borderRadius: 4,
                        marginBottom: 6,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ fontFamily: 'Fraunces, serif', fontWeight: 600 }}>{r}</span>
                      <span style={{ color: 'var(--ink-mid)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}> · base=</span>
                      <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
                        {role.base ?? '?'}
                      </span>
                    </div>
                  );
                })}
              </Section>
            )}

            <Section label="API" title="Интеграции">
              <ApiItem method="GET" path="/health" description="Проверка работоспособности" />
              <ApiItem method="GET" path="/api/domain" description="Текущая ontology (public)" />
              <ApiItem
                method="POST"
                path={`/api/agent/${domainId}/exec`}
                description="Агентский exec (JWT + agent-роль)"
              />
              {projectionIds.slice(0, 5).map((pid) => (
                <div key={pid}>
                  <ApiItem
                    method="GET"
                    path={`/api/document/${pid}?format=html|json`}
                    description={`Document-материализация «${pid}»`}
                  />
                  <ApiItem
                    method="GET"
                    path={`/api/voice/${pid}?format=plain|ssml`}
                    description={`Voice-скрипт «${pid}»`}
                  />
                </div>
              ))}
            </Section>

            <div
              style={{
                marginTop: 64,
                padding: '18px 22px',
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent)',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--ink)',
              }}
            >
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10.5,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--accent)',
                  marginBottom: 8,
                }}
              >
                ⓵ Раннее превью
              </div>
              Это структурный отчёт опубликованного приложения. Полный UI с формами
              и списками будет доступен после стабилизации SDK-рендера (следующий
              milestone) — прочитает ту же ontology и отдаст CRUD автоматически.
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function CounterCard({
  label,
  value,
  preview,
  previewColor,
}: {
  label: string;
  value: number;
  preview?: string[];
  previewColor?: string;
}) {
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
          marginBottom: 8,
        }}
      >
        {value}
      </div>
      {preview && preview.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {preview.map((p) => (
            <li
              key={p}
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                padding: '2px 0',
                color: previewColor ?? 'var(--ink-dim)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 48 }}>
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--ink-mid)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <h2
        style={{
          fontFamily: 'Fraunces, serif',
          fontWeight: 500,
          fontSize: '1.5rem',
          marginBottom: 16,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function ApiItem({
  method,
  path,
  description,
}: {
  method: string;
  path: string;
  description: string;
}) {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'var(--paper-dim)',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        marginBottom: 6,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--accent)', fontWeight: 600, minWidth: 40 }}>{method}</span>
      <span style={{ color: 'var(--ink)' }}>{path}</span>
      <span
        style={{
          color: 'var(--ink-dim)',
          fontFamily: 'Inter, sans-serif',
          fontSize: 12,
          marginLeft: 'auto',
        }}
      >
        {description}
      </span>
    </div>
  );
}
