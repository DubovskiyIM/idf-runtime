import { Router } from 'express';

/**
 * GET /api/viewer — возвращает информацию о текущем viewer'е из JWT.
 *
 * TenantApp использует для:
 *   - role-based filtering в renderer (filterProjectionsByRole)
 *   - display «вы: owner» в header'е (user видит под какой ролью)
 *
 * Viewer middleware уже выставил req.viewer перед попаданием сюда — просто
 * проксируем. Без JWT middleware возвращает 401, до нас не доходит.
 */
export function createViewerInfoRouter(): Router {
  const router = Router();
  router.get('/api/viewer', (req, res) => {
    const viewer = req.viewer;
    if (!viewer) return res.status(401).json({ error: 'no_viewer' });
    return res.json({
      userId: viewer.userId,
      role: viewer.role,
      domainSlug: viewer.domainSlug,
    });
  });
  return router;
}
