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

  /**
   * GET /api/effects — вернуть confirmed Φ-trail для текущего viewer'а.
   *
   * Runtime'у не нужен role-based filter здесь — TenantApp фильтрует world
   * на клиенте через crystallize + renderer ownership checks. Все viewer'ы
   * с валидным JWT и membership на этот slug получают полный trail; scope
   * enforced через fold + projection-level gating.
   *
   * v1: плоский массив без пагинации (tenant обычно ≤ сотен записей в
   * demo-фазе). Follow-up — since / limit params, если dataset растёт.
   */
  router.get('/api/effects', (req, res, next) => {
    try {
      const viewer = req.viewer;
      if (!viewer) return res.status(401).json({ error: 'no_viewer' });
      const effects = deps.store.all();
      return res.json({ effects });
    } catch (e) {
      return next(e);
    }
  });

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
