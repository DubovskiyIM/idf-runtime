import { Router } from 'express';
import { z } from 'zod';
import type { PhiStore } from '../phi/store.js';

const EffectSchema = z.object({
  alpha: z.enum(['create', 'replace', 'remove', 'transition', 'commit']),
  entity: z.string(),
  fields: z.record(z.unknown()),
  context: z.record(z.unknown()).optional(),
});

export type EffectsDeps = {
  store: PhiStore;
  getDomain: () => any;
  validate: (
    e: any,
    domain: any,
    viewer: any
  ) => { ok: true } | { ok: false; reason: string; details?: string };
};

export function createEffectsRouter(deps: EffectsDeps): Router {
  const router = Router();
  router.post('/api/effects', (req, res, next) => {
    try {
      const viewer = req.viewer;
      if (!viewer) return res.status(401).json({ error: 'no_viewer' });

      const parsed = EffectSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_effect' });

      const effect = {
        ...parsed.data,
        context: { ...(parsed.data.context ?? {}), actor: viewer.userId },
      } as any;

      const v = deps.validate(effect, deps.getDomain(), viewer);
      if (!v.ok) {
        deps.store.appendRejected({ ...effect, reason: v.reason, details: v.details });
        return res.status(409).json({ ok: false, reason: v.reason, details: v.details });
      }

      const confirmed = deps.store.append(effect);
      return res.json({ ok: true, effect: confirmed });
    } catch (e) {
      return next(e);
    }
  });
  return router;
}
