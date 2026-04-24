# Runtime shims → upstream SDK

Живой реестр host-side workarounds в `idf-runtime`, которые **должны** быть в SDK.
Каждая запись — симптом, локальный fix (с PR), целевой SDK-пакет и условие снятия.

## Зачем этот документ

Manifesto v2 Часть IV: «адаптер = conformant implementation формата, не фреймворк».
В идеале runtime импортирует SDK и передаёт данные → получает готовый UI. Сейчас
runtime держит ~400 LOC «помощников» поверх SDK — post-factum чинит output
`crystallizeV2` / `ProjectionRendererV2`. Каждая такая функция — **технический долг**,
который блокирует альтернативные хосты (если кто-то захочет написать свой runtime,
он унаследует все эти баги или перепишет заново).

Документ ведём чтобы:
1. Видеть в одном месте, **сколько долга** накопилось
2. При каждом host-fix'е сразу писать, **куда его переместить в SDK**
3. При рефакторинге SDK иметь **готовый список задач**
4. Критерии «shim можно снять» — явные, не из головы

## Формат записи

| Поле | Описание |
|---|---|
| **Symptom** | Что ломалось до fix'а в глазах PM/пользователя |
| **Shim** | Имя функции в `web/src/TenantApp.tsx` или `web/src/buildEffects.ts` |
| **Runtime PR** | Коммит, где shim появился |
| **Target SDK package** | Куда переместить по-правильному |
| **Unblocks removal** | Что должно случиться в SDK, чтобы shim стал не нужен |
| **Scope** | Примерная сложность порта в SDK |

---

## Активные shim'ы (2026-04-24)

> Последний апдейт 2026-04-24: SDK #287 закрыл item #11. Активных shim'ов: 13.

### 1. `foldEffects` → plural-lower Array world shape

- **Symptom:** catalog показывает пустой список при непустом Φ. SDK `DataGrid.resolveItems` ищет `ctx.world["genres"]` как Array, получает `{Genre: {uuid: row}}` Object → `Array.isArray === false` → `items=[]`.
- **Shim:** `foldEffects()` в `TenantApp.tsx` L232. Производит тройной alias:
  - `world.genres` — plural-lower Array (`DataGrid.source`)
  - `world.orderItems` — camel-plural Array (`filterWorldForRole.camelPluralize`)
  - `world.Genre` — CapitalCase Array (legacy dotted-witness)
- **Runtime PR:** [#31](https://github.com/DubovskiyIM/idf-runtime/pull/31)
- **Target:** `@intent-driven/core` или `@intent-driven/engine` — единственная каноническая `fold(Φ)` функция, возвращающая shape который ждут все SDK-consumers (Renderer, filterWorldForRole, dashboardWidgets).
- **Unblocks removal:** `core.fold()` экспортирует готовую map с plural-lower Array. Runtime просто вызывает её.
- **Scope:** S (1-2 дня) — функция уже почти есть (`foldWorld` в core), нужно согласовать shape contract и экспортировать.

### 2. `normalizeIntentAlphas` + `ALPHA_ALIASES` → normalize в SDK

- **Symptom:** Claude эмитит `α:"update"` → `crystallizeV2` падает silent → `<NoProjections>` stub.
- **Shim:** `normalizeIntentAlphas()` в `TenantApp.tsx` L110. Map: update→replace, add/insert→create, delete→remove.
- **Runtime PR:** [#28](https://github.com/DubovskiyIM/idf-runtime/pull/28)
- **Target:** `@intent-driven/core/normalizeIntentsMap` — уже синтезирует particles.effects, должен делать и это.
- **Unblocks removal:** `normalizeIntentsMap` принимает non-canonical α и coerce'ит.
- **Scope:** XS (полдня) — тривиальная карта в существующую функцию.

### 3. `coerceSingleIdRemoveToClickConfirm` → remove-intent дефолты

- **Symptom:** клик «Удалить» в row-menu открывает form-modal с пустым dropdown'ом вместо confirm-dialog.
- **Shim:** `coerceSingleIdRemoveToClickConfirm()` в `TenantApp.tsx` L149. Patches intent: `confirmation:"click"` + `context.__irr:{point:"high"}` если α=remove, 1 id-param.
- **Runtime PR:** [#35](https://github.com/DubovskiyIM/idf-runtime/pull/35)
- **Target:** `@intent-driven/core/normalizeIntentsMap` или `controlArchetypes` — default behavior для remove-intents.
- **Unblocks removal:** SDK при α=remove с id-param'ом дефолтит `confirmation:"click"` и добавляет `__irr.high` если автор не оverride'ил.
- **Scope:** S (1 день) — затрагивает controlArchetypes + тесты.

### 4. `coerceAlpha` map для `buildEffectsFromIntent`

- **Symptom:** defaults (status:"new" в create_lead) + phase-transition values (stage:"qualified" в qualify_deal) теряются. `replace`-intents без value молча пропускались.
- **Shim:** `OP_TO_ALPHA` + merge `src.fields` в `web/src/buildEffects.ts`. Мерджит `particles.effects[*].fields` в output effect row.
- **Runtime PR:** [#27](https://github.com/DubovskiyIM/idf-runtime/pull/27)
- **Target:** `@intent-driven/core` — общая функция `buildEffectsFromIntent(intent, ctx, viewer)` → `{alpha, entity, fields, context}`. Сейчас каждый host пишет свою.
- **Unblocks removal:** SDK экспортирует канонический effect-builder. Host просто вызывает.
- **Scope:** M (3-5 дней) — требует согласования effect-shape contract между host'ами (host idf использует другую форму: `{target, scope, value}`).

### 5. `sanitizeEntities` — drop invalid/dangling `entityRef`

- **Symptom:** Claude создаёт `bookId: {type:"entityRef"}` без target — SDK инферит self-ref, рисует странную `BOOK(1)` subcollection на book_detail.
- **Shim:** `sanitizeEntities()` в `TenantApp.tsx` L53. Дропает:
  - `null`-value fields
  - `entityRef` без `entity`/`ref`
  - `entityRef` с target, которого нет в ontology (dangling ref)
- **Runtime PR:** [#34](https://github.com/DubovskiyIM/idf-runtime/pull/34)
- **Target:** `@intent-driven/core/detectForeignKeys` или новый `sanitizeOntology` step.
- **Unblocks removal:** `detectForeignKeys` валидирует entityRef declaration, dangling refs не создают subcollections.
- **Scope:** S (1 день).

### 6. `effectiveRole` + viewer/role fallback

- **Symptom:** PM с JWT `role:"owner"` (auth-plane meta) видит пустые catalog'и. `ontology.roles` содержит agent/staff/customer без owner → SDK filter'ит до пустоты.
- **Shim:** `effectiveRole` useMemo в `TenantApp.tsx`. JWT.role ∉ ontology → fallback на первую роль с `base:"admin"`, иначе первая объявленная.
- **Runtime PR:** [#30](https://github.com/DubovskiyIM/idf-runtime/pull/30)
- **Target:** `@intent-driven/core/filterWorldForRole` + `baseRoles.cjs` — расширить bypass для tenant-owner meta-роли (как validator уже делает).
- **Unblocks removal:** SDK принимает `viewer.role` и auto-fallback'ит на admin-base, filter возвращает непустой мир для tenant-owner'а.
- **Scope:** M (2-3 дня) — затрагивает baseRoles, filterWorldForRole, visibleFields resolution.

### 7. Nav-stack + `routeParams` state

- **Symptom:** клик по row открывает `<EmptyState title="Выбери элемент из списка">` вместо detail. SDK ждёт `routeParams[idParam]`, host передавал `{{}}` хардкодом. `back()` был `() => undefined`.
- **Shim:** `routeParams` + `navStack` state в `TenantApp.tsx`. `navigate()` pushes, `back()` pops.
- **Runtime PR:** [#32](https://github.com/DubovskiyIM/idf-runtime/pull/32)
- **Target:** `@intent-driven/renderer` — shell-primitive `<NavigationShell>` с встроенным history-stack + breadcrumb. Сейчас каждый host пишет свой.
- **Unblocks removal:** Renderer экспортирует `<NavigationShell>` с router-state. Host просто `<Shell artifacts={...} /><Outlet />`.
- **Scope:** L (1-2 недели) — новая shell-primitive, требует tests + documentation.

### 8. `augmentCatalogRowIntents` — inject per-row intents

- **Symptom:** row context-menu пустой или имеет только read-intents. SDK pattern `row-contextual-actions-menu` в candidate, без `structure.apply`.
- **Shim:** `augmentCatalogRowIntents()` в `TenantApp.tsx`. Detect'ит remove/replace-intents с 1 id-param, inject'ит в `slots.body.item.intents`.
- **Runtime PRs:** [#33](https://github.com/DubovskiyIM/idf-runtime/pull/33), [#38](https://github.com/DubovskiyIM/idf-runtime/pull/38) (phase-aware conditions), [#39](https://github.com/DubovskiyIM/idf-runtime/pull/39) (role filter)
- **Target:** `@intent-driven/core/patterns/stable/catalog/row-contextual-actions-menu` — promote из candidate.
- **Unblocks removal:** pattern имеет `structure.apply`, уважает viewer.role + phase-conditions, inject'ит в artifact.slots.
- **Scope:** M (1 неделя) — promote pattern, пишет `autoDetectIntentsForMainEntity` helper в crystallizeV2, tests.

### 9. `disableRuntimePatterns` — opt-out для `hierarchy-tree-nav`

- **Symptom:** pattern `hierarchy-tree-nav` авто-inject'ит `{type:"treeNav"}` в `slots.sidebar`, MVP shell рендерит отдельным блоком «ИЕРАРХИЯ» без функции.
- **Shim:** `disableRuntimePatterns()` в `TenantApp.tsx`. До `crystallizeV2` добавляет `projection.patterns.disabled: ["hierarchy-tree-nav"]` каждой projection.
- **Runtime PR:** [#36](https://github.com/DubovskiyIM/idf-runtime/pull/36)
- **Target:** `@intent-driven/renderer` — сделать TreeNav-primitive кликабельным nav'ом. Когда это станет, pattern снова полезен.
- **Unblocks removal:** Renderer `<TreeNav>` рендерится inline в nav-стек с click-to-drill. Shell-integration документирована.
- **Scope:** M (1 неделя) — renderer-work, adapter capability, adapter-antd delegation.

### 10. `viewerCanExecute` — role-filter в row-menu

- **Symptom:** staff видит в row-menu `pay_order`, который в canExecute только у customer.
- **Shim:** `viewerCanExecute: Set<intentId>` из `ontology.roles[effectiveRole].canExecute`. Augment фильтрует inject'ируемые intents по этому whitelist'у.
- **Runtime PR:** [#39](https://github.com/DubovskiyIM/idf-runtime/pull/39)
- **Target:** `@intent-driven/core` — новый `filterIntentsByRole(INTENTS, ontology, viewer) → Record<id, intent>`. Параллельный `filterWorldForRole`.
- **Unblocks removal:** SDK provides role-aware intent filter. Applies везде (row-menu, catalog-toolbar, form CTAs).
- **Scope:** S (1-2 дня) — thin helper поверх существующего filterWorldForRole подхода.

### 11. ~~Phase-aware conditions в row-intents~~ ✅ RESOLVED 2026-04-24

- **Symptom:** в Order row со `status:"paid"` показывается `pay_order` (no-op re-pay).
- **Resolution:** SDK [idf-sdk#287](https://github.com/DubovskiyIM/idf-sdk/pull/287) — `normalizeIntentNative` компилирует `intent.precondition: { "Entity.field": [values] }` → `particles.conditions: ["Entity.field = 'v'"]`. `buildItemConditions` в SDK уже подхватывает `particles.conditions` для row-menu filter'а.
- **Runtime PR closing:** [#43](https://github.com/DubovskiyIM/idf-runtime/pull/43) — заменил derivation из `effect.fields` на pass-through `intent.particles.conditions`.
- **Author migration:** каждый phase-transition обязан декларировать `precondition` (из каких source-value можно перейти). Пример: `"qualify_deal": { "α": "replace", "target": "Deal.stage", "precondition": { "Deal.stage": ["prospect"] }, ... }`. Studio prompt обновлён (idf-studio — добавлен раздел в `intents.md`), seed `sales-crm.json` — все phase-transitions декларируют precondition.

### 12. Replace `item.intents` целиком (drop SDK-generated noise)

- **Symptom:** SDK patterns накидывают read-intents в `item.intents` (`list_orders` → «Заказы» в row-меню — не место).
- **Shim:** `augmentCatalogRowIntents` заменяет массив целиком, оставляя только intents с `authored:true`.
- **Runtime PR:** [#39](https://github.com/DubovskiyIM/idf-runtime/pull/39)
- **Target:** `@intent-driven/core/crystallize_v2` — SDK не должен inject'ить read-intents в item.intents вовсе. Read-intents живут на уровне catalog'а.
- **Unblocks removal:** crystallize генерирует чистый `item.intents` без read'ов. `catalog-creator-toolbar` и др. patterns trustly targeted.
- **Scope:** M (2-3 дня) — аудит всех патернов inject'ирующих в item.intents.

### 13. `RendererBoundary` — error boundary вокруг `<ProjectionRendererV2>`

- **Symptom:** renderer throws → blank screen без debug-инфы.
- **Shim:** `RendererBoundary` class component в `TenantApp.tsx`. Показывает error + stack + pid.
- **Runtime PR:** [#28](https://github.com/DubovskiyIM/idf-runtime/pull/28)
- **Target:** `@intent-driven/renderer` — экспортировать `<RendererBoundary>` как named export.
- **Unblocks removal:** Renderer ships boundary, host wraps:
  ```jsx
  <RendererBoundary><ProjectionRendererV2 ... /></RendererBoundary>
  ```
- **Scope:** XS (полдня).

### 14. `<NoProjections>` diagnostic panel

- **Symptom:** `artifactsMap = {}` → NoProjections stub без объяснения почему.
- **Shim:** `NoProjections` в `TenantApp.tsx` показывает entities/intents/artifacts counts + подсказки «нет list_*» / «read есть, artifacts=0».
- **Runtime PR:** [#28](https://github.com/DubovskiyIM/idf-runtime/pull/28)
- **Target:** `@intent-driven/renderer` — `<ProjectionRendererV2 debugMode={...}>` или `<SpecDiagnostic artifacts ontology />` helper.
- **Unblocks removal:** Renderer имеет встроенный diagnostic mode.
- **Scope:** S (1-2 дня).

---

## Workflow/Infra (не runtime-shim, но связанные)

### W1. `no-cache: true` в `deploy.yml`

- **Symptom:** buildx/gha cache serve'ит stale `RUN npx vite build` layer — bundle не содержит новых web/ changes несмотря на merged PR.
- **Shim:** `no-cache: true` в `docker/build-push-action@v6`.
- **Runtime PR:** [#34](https://github.com/DubovskiyIM/idf-runtime/pull/34)
- **Target:** GHA `docker/build-push-action` или docker buildx — content-hash invalidation работает правильно.
- **Unblocks removal:** найти причину stale cache и перейти на cache-mount с правильным key. Пока — +2 мин на build не критично.

---

## Снятие shim'а — процесс

Когда порт в SDK сделан:

1. Обновить раздел записи в этом файле: `~~зачёркнуть~~` + ссылка на SDK PR
2. Удалить shim-функцию из runtime + adjust call-site
3. Bump SDK version в `package.json`
4. Run tests, verify на shop tenant
5. Удалить запись через 1 месяц после проверки (git log keeps history)

## Метрика здоровья

- **Активных shim'ов:** 13 (было 14 до SDK #287)
- **Строк кода в shim'ах:** ~385 LOC в TenantApp.tsx + ~40 в buildEffects.ts
- **Целевой state:** 0 активных shim'ов (runtime = thin wrapper над SDK + server + JWT forwarding)
- **Когда считать SDK готовым для public API:** ≤3 активных shim'а (domain-specific полировка)

## Приоритет для sprint'а порта

Если выделить 2 недели на «снятие долга», в таком порядке:

1. **#1 foldEffects** (S) — контракт shape'а, блокирует консистентность всех hosts
2. **#2 normalizeIntentAlphas** (XS) — тривиально, закрывает silent-fail
3. **#10 viewerCanExecute** (S) — чистая новая helper-функция
4. **#8 augmentCatalogRowIntents → pattern promote** (M) — решает 3 shim'а разом (#8, #11, #12)
5. **#6 effectiveRole** (M) — SDK-native tenant-owner bypass
6. **#5 sanitizeEntities + detectForeignKeys** (S) — проблема Claude-авторинга
7. **#3 remove-intent defaults** (S)
8. **#7 NavigationShell** (L) — большая shell-primitive, отдельный sprint

Итог ~3-4 недели при одном full-time разработчике. Runtime TenantApp усохнет с 1000+ LOC до ~200-300.
