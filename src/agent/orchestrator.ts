import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  runToolUseLoop as realRunner,
  type TurnEvent,
  type ToolHandlers,
} from './claude-tooluse.js';
import { checkPreapprovalForIntent } from '../validator/preapproval.js';
import { checkInvariantsForEffect } from '../validator/invariants.js';
import { evaluateRules } from '../rules/evaluate.js';
import type { PhiStore, Effect } from '../phi/store.js';

export type OrchestratorDeps = {
  getDomain: () => any;
  getWorld: (viewer: any) => any;
  getStore: () => PhiStore;
  runToolUseLoop?: typeof realRunner;
  onAgentTurnStart?: () => void;
  onAgentTurnEnd?: () => void;
  /**
   * Override для тестов — вместо subprocess-call использовать inline logic.
   * Если не задан, runner = realRunner (real claude CLI).
   */
};

export function createConsoleTurnHandler(deps: OrchestratorDeps) {
  const runner = deps.runToolUseLoop ?? realRunner;
  return async function handler(req: any, res: Response) {
    if (!req.viewer) {
      return res.status(401).json({ error: 'no_viewer' });
    }
    // Нормализуем viewer: middleware ставит userId, SDK ожидает id
    const viewer = { ...req.viewer, id: req.viewer.id ?? req.viewer.userId };
    const task = req.body?.task;
    if (!task) {
      return res.status(400).json({ error: 'task_required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (e: TurnEvent) => {
      try {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch {
        /* client disconnected */
      }
    };

    const domain = deps.getDomain();
    const worldForPrompt = deps.getWorld(viewer);
    const systemPrompt = buildSystemPrompt(domain, worldForPrompt, viewer.role);

    deps.onAgentTurnStart?.();

    const tools: ToolHandlers = {
      exec_intent: async (input: any) => execInline(input, viewer, deps),
      observe_world: async (input: any) => {
        const w = deps.getWorld(viewer);
        if (input?.entity) {
          const key = pluralizeLower(input.entity);
          return { [input.entity]: (w[key] ?? []).slice(0, 20) };
        }
        return summarizeWorld(w);
      },
      wait_for_signal: async (input: any) => {
        const ms = Math.min(Number(input?.maxMs ?? 2000), 10_000);
        await new Promise((r) => setTimeout(r, ms));
        return { waited: ms };
      },
    };

    try {
      await runner({
        task,
        systemPrompt,
        tools,
        onEvent: send,
        maxCalls: 10,
        timeoutMs: 120_000,
      });
    } catch (e: any) {
      send({ kind: 'error', message: String(e?.message ?? e) });
    } finally {
      deps.onAgentTurnEnd?.();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * In-process exec (не HTTP) для tool-use loop. Повторяет логику /exec route
 * чтобы избежать self-call и auth-roundtrip. Возвращает stub response
 * с тем же shape что /exec.
 */
function execInline(
  input: { intentId?: string; params?: any },
  viewer: any,
  deps: OrchestratorDeps,
): Promise<any> {
  return new Promise((resolve) => {
    try {
      const { intentId, params } = input ?? {};
      if (!intentId) return resolve({ ok: false, reason: 'intentId_required' });
      const domain = deps.getDomain();
      const role = domain?.roles?.[viewer.role];
      if (!role?.canExecute?.includes(intentId)) {
        return resolve({ ok: false, reason: 'intent_not_permitted' });
      }
      const intent = domain.intents?.[intentId];
      if (!intent) return resolve({ ok: false, reason: 'intent_not_found' });

      const paramsObj = params ?? {};
      const sdkWorld = deps.getWorld(viewer);
      const pa = checkPreapprovalForIntent(
        intentId,
        paramsObj,
        viewer,
        domain,
        sdkWorld,
        viewer.role,
      );
      if (!pa.ok) {
        return resolve({
          ok: false,
          reason: 'preapproval_denied',
          failedCheck: pa.failedCheck,
          intentId,
        });
      }

      const candidates = (intent.particles?.effects ?? []).map((tpl: any) => {
        const norm = normalizeEffectTemplate(tpl);
        return {
          entity: norm.entity,
          alpha: norm.alpha,
          value: substitute(norm.value, { params: paramsObj, viewer }),
        };
      });
      if (candidates.length === 0) {
        return resolve({ ok: false, reason: 'no_effects_from_intent', intentId });
      }

      const store = deps.getStore();
      const effectIds: string[] = [];
      const derived: any[] = [];

      for (const c of candidates) {
        if (!c.value.id || c.value.id === '{{auto}}') {
          c.value.id = `eff-${randomUUID().slice(0, 8)}`;
        }
        const iv = checkInvariantsForEffect(c, domain, toSdkWorld(deps.getWorld(viewer)));
        if (!iv.ok) {
          return resolve({
            ok: false,
            reason: 'invariant_violated',
            invariantName: iv.violations[0]?.name,
            intentId,
          });
        }
        store.append(toStoreEffect(c, viewer.id));
        effectIds.push(c.value.id);

        const ruleDerived = evaluateRules(
          domain.rules ?? [],
          deps.getWorld(viewer),
          c,
        );
        for (const d of ruleDerived) {
          if (!d.value.id || d.value.id === '{{auto}}') {
            d.value.id = `eff-${randomUUID().slice(0, 8)}`;
          }
          const dIv = checkInvariantsForEffect(d, domain, toSdkWorld(deps.getWorld(viewer)));
          if (!dIv.ok) continue;
          store.append(toStoreEffect(d, viewer.id));
          derived.push({ entity: d.entity, id: d.value.id });
        }
      }

      resolve({ ok: true, intentId, effectIds, derived });
    } catch (e: any) {
      resolve({ ok: false, reason: 'exception', error: String(e?.message ?? e) });
    }
  });
}

function buildSystemPrompt(domain: any, world: any, roleName: string): string {
  const role = domain?.roles?.[roleName] ?? {};
  const allowed: string[] = role.canExecute ?? [];
  const intentDocs = allowed
    .map((id) => {
      const i = domain.intents?.[id];
      if (!i) return null;
      return `- ${id}: ${i.description ?? i.label ?? ''} (params: ${JSON.stringify(
        i.parameters ?? {},
      )})`;
    })
    .filter(Boolean)
    .join('\n');

  const summary = summarizeWorld(world);

  return `Ты — агент-исполнитель инвест-портфеля.

Доступные intent'ы:
${intentDocs}

Текущее состояние мира: ${JSON.stringify(summary)}

Tools:
- exec_intent(intentId, params) — выполнить intent. Вернёт { ok, intentId, effectIds? | reason, failedCheck? }.
- observe_world(entity?) — прочитать состояние.
- wait_for_signal(maxMs) — подождать market signal.

Правила: не придумывай новых intent'ов. Если exec_intent вернул rejected — проанализируй reason и попробуй другой подход. Максимум 10 tool-calls.`;
}

function summarizeWorld(world: any): Record<string, { count: number }> {
  const out: Record<string, { count: number }> = {};
  for (const [k, v] of Object.entries(world ?? {})) {
    out[k] = { count: Array.isArray(v) ? v.length : 0 };
  }
  return out;
}

function toSdkWorld(runtimeWorld: any): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const [entity, rowsDict] of Object.entries(runtimeWorld ?? {})) {
    if (!rowsDict || typeof rowsDict !== 'object') continue;
    if (Array.isArray(rowsDict)) {
      out[entity] = rowsDict;
    } else {
      out[pluralizeLower(entity)] = Object.values(rowsDict) as any[];
    }
  }
  return out;
}

function pluralizeLower(entity: string): string {
  const camel = entity[0].toLowerCase() + entity.slice(1);
  if (camel.endsWith('y')) return camel.slice(0, -1) + 'ies';
  if (camel.endsWith('s')) return camel + 'es';
  return camel + 's';
}

/**
 * Normalize host-format ({α, target, fields}) и runtime-native ({alpha, entity, value})
 * в общий shape. См. `src/routes/agent.ts::normalizeEffectTemplate` — там source of truth.
 */
function normalizeEffectTemplate(tpl: any): {
  entity: string;
  alpha: string;
  value: Record<string, any>;
} {
  const rawAlpha = tpl.alpha ?? tpl.α ?? 'create';
  const alpha = rawAlpha === 'add' ? 'create' : rawAlpha;
  const target = tpl.target ?? tpl.entity ?? '';
  const entity = String(target).split('.')[0];
  const value = tpl.value ?? tpl.fields ?? {};
  return { entity, alpha, value };
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
    } else {
      out[k] = substitute(v, ctx);
    }
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
