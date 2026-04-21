import { Router } from 'express';
import { createAdminAuth } from './auth.js';
import type { PhiStore } from '../phi/store.js';

export function createAdminHealthRouter(deps: { store: PhiStore; secret: string }): Router {
  const router = Router();
  router.get('/admin/health', createAdminAuth(deps.secret), (_req, res) => {
    res.json({
      status: 'ok',
      effects: deps.store.count(),
      uptime_seconds: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  return router;
}
