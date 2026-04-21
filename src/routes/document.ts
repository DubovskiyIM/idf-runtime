import { Router } from 'express';
import { materializeAsDocument, renderDocumentHtml } from '@intent-driven/core';

export type DocumentDeps = {
  getDomain: () => any;
  getWorld: (viewer: any) => any;
};

export function createDocumentRouter(deps: DocumentDeps): Router {
  const router = Router();
  router.get('/api/document/:slug/:projection', async (req, res, next) => {
    try {
      const viewer = req.viewer;
      if (!viewer) return res.status(401).json({ error: 'no_viewer' });

      const domain = deps.getDomain();
      const projection = domain?.projections?.[req.params.projection];
      if (!projection) return res.status(404).json({ error: 'unknown_projection' });

      const world = deps.getWorld(viewer);
      const format = String(req.query.format ?? 'json');
      const doc = materializeAsDocument(projection, world, viewer);

      if (format === 'html') {
        return res.type('text/html').send(renderDocumentHtml(doc as any));
      }
      return res.json(doc);
    } catch (e) {
      return next(e);
    }
  });
  return router;
}
