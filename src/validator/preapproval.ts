import { checkPreapproval } from '@intent-driven/core';

export type PreapprovalResult =
  | { ok: true; preapprovalId?: string }
  | { ok: false; failedCheck?: string; reason: string; details?: any };

/**
 * Per-intent preapproval check. Тонкий wrapper поверх SDK checkPreapproval с
 * нормализацией ответа. Если ontology.roles[role].preapproval не декларирован
 * или intent не в requiredFor — всегда ok:true.
 */
export function checkPreapprovalForIntent(
  intentId: string,
  params: Record<string, any>,
  viewer: any,
  ontology: any,
  world: any,
  roleName: string = 'agent',
): PreapprovalResult {
  try {
    const result: any = (checkPreapproval as any)(
      intentId,
      params,
      viewer,
      ontology,
      world,
      roleName,
    );
    if (!result || result.ok) {
      return { ok: true, preapprovalId: result?.preapprovalId };
    }
    return {
      ok: false,
      failedCheck: result.failedCheck,
      reason: result.reason ?? 'preapproval_denied',
      details: result.details,
    };
  } catch (e: any) {
    return { ok: false, reason: 'exception', details: String(e?.message ?? e) };
  }
}
