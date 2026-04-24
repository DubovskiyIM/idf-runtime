import { Router } from 'express';
import { createAdminAuth } from './auth.js';
import type { SignalFeeder } from '../ml/signalFeeder.js';

export type SignalsRouterDeps = {
  getFeeder: () => SignalFeeder | null;
  secret: string;
};

/**
 * POST /admin/signals/{start,stop,reset} + GET /admin/signals/status.
 * Позволяет orchestrator'у (или manual rehearsal) управлять signalFeeder'ом
 * invest-tenant'а. Feeder — per-tenant, привязан к domain.ontology.signalScript.
 */
export function createAdminSignalsRouter(deps: SignalsRouterDeps): Router {
  const router = Router();
  const auth = createAdminAuth(deps.secret);

  router.post('/admin/signals/start', auth, (_req, res) => {
    const f = deps.getFeeder();
    if (!f) return res.status(503).json({ error: 'no_feeder' });
    f.start();
    return res.json({ ok: true, ...f.status() });
  });

  router.post('/admin/signals/stop', auth, (_req, res) => {
    const f = deps.getFeeder();
    if (!f) return res.status(503).json({ error: 'no_feeder' });
    f.stop();
    return res.json({ ok: true, ...f.status() });
  });

  router.post('/admin/signals/reset', auth, (_req, res) => {
    const f = deps.getFeeder();
    if (!f) return res.status(503).json({ error: 'no_feeder' });
    f.reset();
    return res.json({ ok: true });
  });

  router.get('/admin/signals/status', auth, (_req, res) => {
    const f = deps.getFeeder();
    if (!f) return res.status(503).json({ error: 'no_feeder' });
    return res.json(f.status());
  });

  return router;
}
