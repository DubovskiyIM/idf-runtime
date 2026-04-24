import { Router } from 'express';
import { filterWorldForRole } from '@intent-driven/core';
import { randomUUID } from 'node:crypto';
import { checkPreapprovalForIntent } from '../validator/preapproval.js';
import { checkInvariantsForEffect } from '../validator/invariants.js';
import { evaluateRules } from '../rules/evaluate.js';
import type { PhiStore, Effect } from '../phi/store.js';

export type AgentDeps = {
  getDomain: () => any;
  getWorld: (viewer: any) => any;
  getStore: () => PhiStore;
  onAgentTurnStart?: () => void;
  onAgentTurnEnd?: () => void;
};

export function createAgentRouter(deps: AgentDeps): Router {
  const router = Router();

  router.get('/api/agent/:slug/schema', (req: any, res) => {
    if (!req.viewer) return res.status(401).json({ error: 'no_viewer' });
    const domain = deps.getDomain();
    const role = domain?.roles?.[req.viewer.role] ?? {};
    const allowed: string[] = role.canExecute ?? [];
    const intents = Object.fromEntries(
      Object.entries(domain?.intents ?? {}).filter(([k]) => allowed.includes(k)),
    );
    return res.json({ intents, entities: domain?.entities ?? {} });
  });

  router.get('/api/agent/:slug/world', (req: any, res) => {
    if (!req.viewer) return res.status(401).json({ error: 'no_viewer' });
    const domain = deps.getDomain();
    const world = deps.getWorld(req.viewer);
    try {
      const filtered = filterWorldForRole(world, domain, req.viewer.role, req.viewer);
      return res.json({ world: filtered });
    } catch {
      return res.json({ world });
    }
  });

  router.post('/api/agent/:slug/exec', (req: any, res) => {
    if (!req.viewer) return res.status(401).json({ error: 'no_viewer' });

    const { intentId, params } = req.body ?? {};
    if (!intentId) return res.status(400).json({ ok: false, reason: 'intentId_required' });

    const domain = deps.getDomain();
    const role = domain?.roles?.[req.viewer.role];
    if (!role?.canExecute?.includes(intentId)) {
      return res.status(405).json({ ok: false, reason: 'intent_not_permitted' });
    }
    const intent = domain.intents?.[intentId];
    if (!intent) return res.status(404).json({ ok: false, reason: 'intent_not_found' });

    const paramsObj = params ?? {};

    const sdkWorld = toSdkWorld(deps.getWorld(req.viewer));
    const pa = checkPreapprovalForIntent(
      intentId,
      paramsObj,
      req.viewer,
      domain,
      sdkWorld,
      req.viewer.role,
    );
    if (!pa.ok) {
      return res.status(403).json({
        ok: false,
        reason: 'preapproval_denied',
        failedCheck: pa.failedCheck,
        details: pa.details,
      });
    }

    const candidateEffects = buildEffectsFromParticles(intent, paramsObj, req.viewer);
    if (candidateEffects.length === 0) {
      return res.status(400).json({ ok: false, reason: 'no_effects_from_intent' });
    }

    const store = deps.getStore();
    const accepted: Array<{ entity: string; id: string }> = [];
    const derived: any[] = [];

    for (const candidate of candidateEffects) {
      if (!candidate.value.id || candidate.value.id === '{{auto}}') {
        candidate.value.id = `eff-${randomUUID().slice(0, 8)}`;
      }

      const ivWorld = toSdkWorld(deps.getWorld(req.viewer));
      const iv = checkInvariantsForEffect(candidate, domain, ivWorld);
      if (!iv.ok) {
        for (const a of accepted) appendRollback(store, a.entity, a.id);
        return res.status(409).json({
          ok: false,
          reason: 'invariant_violated',
          invariantName: iv.violations[0]?.name,
          message: iv.violations[0]?.message,
        });
      }

      store.append(toStoreEffect(candidate, req.viewer.id));
      accepted.push({ entity: candidate.entity, id: candidate.value.id });

      const worldAfter = toSdkWorld(deps.getWorld(req.viewer));
      const ruleDerived = evaluateRules(domain.rules ?? [], worldAfter, candidate);
      for (const d of ruleDerived) {
        if (!d.value.id || d.value.id === '{{auto}}') {
          d.value.id = `eff-${randomUUID().slice(0, 8)}`;
        }
        const dIv = checkInvariantsForEffect(d, domain, toSdkWorld(deps.getWorld(req.viewer)));
        if (!dIv.ok) continue;
        store.append(toStoreEffect(d, req.viewer.id));
        derived.push({ entity: d.entity, id: d.value.id });
      }
    }

    return res.json({
      ok: true,
      effectIds: accepted.map((a) => a.id),
      derived,
    });
  });

  return router;
}

/**
 * Runtime getWorld возвращает PascalCase dict `{Entity: {id: row}}`.
 * SDK preapproval/invariants ожидают camelCase plural collection `{entities: [rows]}`.
 */
function toSdkWorld(runtimeWorld: any): any {
  const out: Record<string, any[]> = {};
  for (const [entity, rowsDict] of Object.entries(runtimeWorld ?? {})) {
    if (!rowsDict || typeof rowsDict !== 'object') continue;
    const rows = Array.isArray(rowsDict) ? rowsDict : Object.values(rowsDict);
    out[pluralizeLower(entity)] = rows as any[];
  }
  return out;
}

function pluralizeLower(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower.endsWith('s')) return lower + 'es';
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies';
  return lower + 's';
}

function buildEffectsFromParticles(
  intent: any,
  params: any,
  viewer: any,
): Array<{ entity: string; alpha: string; value: Record<string, any> }> {
  const templates = intent.particles?.effects ?? [];
  return templates.map((tpl: any) => ({
    entity: tpl.entity,
    alpha: tpl.alpha,
    value: substitute(tpl.value, { params, viewer }),
  }));
}

function substitute(obj: any, ctx: { params: any; viewer: any }): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => substitute(v, ctx));
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const m = v.match(/^\{\{(params|viewer)\.(\w+)\}\}$/);
      if (m) out[k] = (ctx as any)[m[1]]?.[m[2]];
      else out[k] = v;
    } else out[k] = substitute(v, ctx);
  }
  return out;
}

function toStoreEffect(
  candidate: { entity: string; alpha: string; value: Record<string, any> },
  viewerId: string,
): Effect {
  return {
    alpha: candidate.alpha as Effect['alpha'],
    entity: candidate.entity,
    fields: { ...candidate.value },
    context: { viewerId, source: 'agent' },
  };
}

function appendRollback(store: PhiStore, entity: string, id: string): void {
  store.append({
    alpha: 'remove',
    entity,
    fields: { id },
    context: { rollback: true },
  });
}
