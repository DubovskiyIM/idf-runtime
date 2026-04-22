import { Router } from 'express';

/**
 * Public API для tenant-frontend React-бандла: `/api/domain` отдаёт
 * текущую ontology — frontend fetch'ит на mount'е, строит DomainSpec,
 * рендерит V2Shell-like shell через ProjectionRendererV2 + adapter.
 *
 * Ontology = schema-уровень, не содержит user данных → безопасно public.
 * (World state через /api/effects остаётся под viewer-auth middleware.)
 *
 * Сам `/` route не регистрируем — Vite-built index.html в static/ уже
 * обслуживается express.static'ом + содержит SPA-entry для React-бандла.
 */

export type TenantIndexDeps = {
  getDomain: () => unknown;
  tenantSlug: string;
};

export function createTenantIndexRouter(deps: TenantIndexDeps): Router {
  const router = Router();

  router.get('/api/domain', (_req, res) => {
    res.json(deps.getDomain() ?? {});
  });

  return router;
}
