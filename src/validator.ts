import { checkInvariants, checkPreapproval } from '@intent-driven/core';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

export function makeValidator() {
  return function validate(effect: any, domain: any, viewer: any): ValidationResult {
    // 1. role существует
    const role = domain?.roles?.[viewer.role];
    if (!role) return { ok: false, reason: 'unknown_role' };

    // 2. role.canExecute — thin intent-level check
    const intentName = effect?.context?.intent;
    if (
      role.canExecute &&
      intentName &&
      role.canExecute !== '*' &&
      Array.isArray(role.canExecute) &&
      !role.canExecute.includes(intentName)
    ) {
      return { ok: false, reason: 'role_cannot_execute' };
    }

    // 3. preapproval (если agent с guard'ом) — в M1 делаем best-effort вызов
    if (role.base === 'agent' && role.preapproval && intentName) {
      try {
        const params = effect?.fields ?? {};
        const g: any = checkPreapproval(
          intentName,
          params,
          viewer,
          domain,
          {},
          viewer.role
        );
        if (g && g.ok === false) {
          return { ok: false, reason: 'preapproval', details: g.reason ?? 'denied' };
        }
      } catch (err: any) {
        return { ok: false, reason: 'preapproval_error', details: err?.message };
      }
    }

    // 4. invariants per-effect — синтетический world-check.
    //    Полная проверка (реальный Φ после apply) — в integrity.ts на reload.
    try {
      const res: any = checkInvariants({}, domain, {});
      const errs = (res?.violations ?? []).filter((v: any) => v.severity === 'error');
      if (errs.length) {
        return {
          ok: false,
          reason: `invariant_${errs[0].kind ?? 'violation'}`,
          details: errs[0].message,
        };
      }
    } catch {
      // integrity.ts отсекает broken ontology на reload;
      // runtime invariant-issues — не блокируют effect
    }

    return { ok: true };
  };
}
