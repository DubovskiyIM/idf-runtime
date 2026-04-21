import { Router } from 'express';
import { filterWorldForRole } from '@intent-driven/core';

export type AgentDeps = {
  getDomain: () => any;
  getWorld: (viewer: any) => any;
};

export function createAgentRouter(deps: AgentDeps): Router {
  const router = Router();

  router.get('/api/agent/:slug/schema', (req, res) => {
    const viewer = req.viewer;
    if (!viewer) return res.status(401).json({ error: 'no_viewer' });
    const domain = deps.getDomain();
    return res.json({
      intents: domain?.intents ?? {},
      entities: domain?.entities ?? {},
    });
  });

  router.get('/api/agent/:slug/world', (req, res) => {
    const viewer = req.viewer;
    if (!viewer) return res.status(401).json({ error: 'no_viewer' });
    const domain = deps.getDomain();
    const world = deps.getWorld(viewer);
    try {
      const filtered = filterWorldForRole(world, domain, viewer.role, viewer);
      return res.json({ world: filtered });
    } catch {
      return res.json({ world });
    }
  });

  router.post('/api/agent/:slug/exec', (req, res) => {
    const viewer = req.viewer;
    if (!viewer) return res.status(401).json({ error: 'no_viewer' });
    return res.status(501).json({ ok: false, reason: 'exec_M2' });
  });

  return router;
}
