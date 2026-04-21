import { Router } from 'express';
import { createAdminAuth } from './auth.js';
import type { PhiStore } from '../phi/store.js';

export function createAuditRouter(deps: { store: PhiStore; secret: string }): Router {
  const router = Router();
  const auth = createAdminAuth(deps.secret);

  router.get('/admin/audit', auth, (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const entity = req.query.entity ? String(req.query.entity) : undefined;
    const limit = Number(req.query.limit ?? 100);
    const offset = Number(req.query.offset ?? 0);
    const effects = deps.store.audit({ since, entity, limit, offset });
    res.json({ effects, total: deps.store.count() });
  });

  router.get('/admin/rejected', auth, (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const limit = Number(req.query.limit ?? 100);
    res.json({ rejected: deps.store.rejected({ since, limit }) });
  });

  return router;
}
