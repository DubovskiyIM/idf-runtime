import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tenant overview page — vanilla HTML/JS без React-bundle'а. Нужен для M1.2
 * dogfood'а: PM после «Опубликовать» должен видеть структуру своего домена
 * (entities, intents, roles, projections, 4-channel endpoints).
 *
 * Host idf'овский бандл имеет хардкодед routes для 14 demo-доменов — он не
 * умеет рендерить arbitrary user-created ontology. Этот endpoint обходит
 * его целиком: custom HTML встраивает currentDomain как JS const, рендерит
 * простой overview + ссылки на API (/api/document, /api/voice, /api/agent).
 *
 * Для full-featured V2Shell (форма добавления записей + списки + data
 * editing) нужен отдельный SDK-based bundle в runtime-specific frontend —
 * roadmap M1.3.
 */

export type TenantIndexDeps = {
  getDomain: () => unknown;
  tenantSlug: string;
  htmlPath?: string;
};

export function createTenantIndexRouter(deps: TenantIndexDeps): Router {
  const router = Router();
  const htmlPath = deps.htmlPath ?? join(process.cwd(), 'static/tenant-index.html');

  router.get('/', (_req, res) => {
    try {
      const html = readFileSync(htmlPath, 'utf8');
      const domain = deps.getDomain();
      const injected = html.replace(
        '__TENANT_DOMAIN_JSON__',
        JSON.stringify(domain).replace(/</g, '\\u003c'),
      );
      res.type('html').send(injected);
    } catch (e) {
      res.status(500).type('text/plain').send(
        `tenant-index error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  return router;
}
