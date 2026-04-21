import { Router } from 'express';
import { createAdminAuth } from './auth.js';
import { checkIntegrity } from '../domain/integrity.js';
import { writeDomain } from '../domain/loader.js';
import type { PhiStore } from '../phi/store.js';

export type ReloadRouterDeps = {
  dataDir: string;
  secret: string;
  store: PhiStore;
  onAccept: (ontology: any) => void | Promise<void>;
};

export function createReloadRouter(deps: ReloadRouterDeps): Router {
  const router = Router();
  router.post('/admin/reload', createAdminAuth(deps.secret), async (req: any, res, next) => {
    try {
      const domain = req.body;
      if (!domain?.entities) return res.status(400).json({ error: 'invalid_body' });

      const result = checkIntegrity(deps.store, domain);
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          rejectedEffects: result.rejectedEffects,
          totalEffects: result.totalEffects,
        });
      }

      writeDomain(deps.dataDir, req.rawBody ?? JSON.stringify(domain));
      await deps.onAccept(domain);

      res.json({
        ok: true,
        totalEffects: result.totalEffects,
        version: domain.__version ?? 'unknown',
      });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
