import { Router } from 'express';
import { z } from 'zod';
import { createAdminAuth } from './auth.js';
import type { PhiStore } from '../phi/store.js';

const SeedSchema = z.object({
  effects: z
    .array(
      z.object({
        id: z.string().min(1),
        alpha: z.enum(['create', 'replace', 'remove', 'transition', 'commit']),
        entity: z.string().min(1),
        fields: z.record(z.unknown()),
        context: z.record(z.unknown()).optional(),
        confirmedAt: z.string().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export type SeedRouterDeps = {
  store: PhiStore;
  secret: string;
};

/**
 * POST /admin/seed — bulk-insert effects с provided id (INSERT OR IGNORE).
 *
 * Используется studio orchestrator'ом при первом deploy'е template'а: после
 * docker up + seedDomain, orchestrator POSTит SEED_EFFECTS из template JSON
 * (sales-crm имеет ~17 sample records для непустого демо).
 *
 * Идемпотентен: повторный вызов не дублирует (INSERT OR IGNORE по id).
 * Runtime обычно restart'ится orchestrator'ом после seedDomain (чтобы
 * подхватить новый domain.json) — seed'ы применяются до restart'а
 * непосредственно через sqlite.
 *
 * Validator bypass: seed'ы — не user input; template-author гарантирует
 * их валидность. Role-capability check не применяется (admin-layer).
 */
export function createSeedRouter(deps: SeedRouterDeps): Router {
  const router = Router();
  router.post('/admin/seed', createAdminAuth(deps.secret), (req, res, next) => {
    try {
      const parsed = SeedSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

      // Effect.context required в PhiStore (fold ожидает object). zod делает
      // optional — нормализуем в пустой object перед передачей.
      const normalized = parsed.data.effects.map((e) => ({
        ...e,
        context: e.context ?? {},
      }));
      const { inserted } = deps.store.seedBatch(normalized);
      return res.json({ ok: true, inserted, total: normalized.length });
    } catch (e) {
      return next(e);
    }
  });
  return router;
}
