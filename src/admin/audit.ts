import { Router } from 'express';
import { createAdminAuth } from './auth.js';
import type { PhiStore } from '../phi/store.js';

export function createAuditRouter(deps: { store: PhiStore; secret: string }): Router {
  const router = Router();
  const auth = createAdminAuth(deps.secret);

  router.get('/admin/audit', auth, (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const until = req.query.until ? new Date(String(req.query.until)) : undefined;
    const entity = req.query.entity ? String(req.query.entity) : undefined;
    const role = req.query.role ? String(req.query.role) : undefined;
    const limit = Number(req.query.limit ?? 100);
    const offset = Number(req.query.offset ?? 0);
    const effects = deps.store.audit({ since, entity, limit, offset });
    // role + until — post-query filter поверх SQL-результата.
    // role: смотрит context.viewerRole (записывается в /api/effects POST),
    // fallback на context.actorRole (legacy / seed-данные).
    // until: confirmedAt < until — SQL audit() не имеет until.
    const filteredByRole = role
      ? effects.filter((e) => {
          const ctx = (e.context ?? {}) as Record<string, unknown>;
          return ctx.viewerRole === role || ctx.actorRole === role;
        })
      : effects;
    const final = until
      ? filteredByRole.filter((e) => e.confirmedAt < until)
      : filteredByRole;
    res.json({ effects: final, total: deps.store.count() });
  });

  router.get('/admin/rejected', auth, (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : undefined;
    const limit = Number(req.query.limit ?? 100);
    res.json({ rejected: deps.store.rejected({ since, limit }) });
  });

  return router;
}
