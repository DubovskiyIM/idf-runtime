import { checkInvariants, checkPreapproval } from '@intent-driven/core';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

/**
 * Tenant-owner (auth plane meta-role) — super-user bypass.
 *
 * `owner` в контексте auth-membership обозначает владельца tenant'а, а
 * не одну из доменных ролей (sdr/ae/manager и пр.). Ontology-author
 * формирует role-map под бизнес-семантику и не обязан объявлять
 * технический "owner". Без bypass'а создатель project'а не может ничего
 * сделать в собственном tenant'е.
 *
 * Bypass применяется только если role-id отсутствует в ontology — если
 * автор явно объявил `owner` в ролях (с своим набором canExecute), его
 * декларация побеждает.
 */
const TENANT_OWNER_ROLE = 'owner';

export function makeValidator() {
  return function validate(effect: any, domain: any, viewer: any): ValidationResult {
    // 1. role существует — с bypass'ом для tenant-owner'а
    const role = domain?.roles?.[viewer.role];
    if (!role) {
      if (viewer.role === TENANT_OWNER_ROLE) return { ok: true };
      return { ok: false, reason: 'unknown_role' };
    }

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
