import { Router } from 'express';
import { materializeAsVoice, renderVoiceSsml, renderVoicePlain } from '@intent-driven/core';

export type VoiceDeps = {
  getDomain: () => any;
  getWorld: (viewer: any) => any;
};

export function createVoiceRouter(deps: VoiceDeps): Router {
  const router = Router();
  router.get('/api/voice/:slug/:projection', async (req, res, next) => {
    try {
      const viewer = req.viewer;
      if (!viewer) return res.status(401).json({ error: 'no_viewer' });

      const domain = deps.getDomain();
      const projection = domain?.projections?.[req.params.projection];
      if (!projection) return res.status(404).json({ error: 'unknown_projection' });

      const world = deps.getWorld(viewer);
      const format = String(req.query.format ?? 'json');
      const script = materializeAsVoice(projection, world, viewer);

      if (format === 'audio') {
        return res.status(501).json({ error: 'audio_format_M2' });
      }
      if (format === 'ssml') {
        return res.type('application/ssml+xml').send(renderVoiceSsml(script as any));
      }
      if (format === 'plain') {
        return res.type('text/plain').send(renderVoicePlain(script as any));
      }
      return res.json(script);
    } catch (e) {
      return next(e);
    }
  });
  return router;
}
