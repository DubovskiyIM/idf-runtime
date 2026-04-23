import { describe, it, expect } from 'vitest';
import { makeValidator } from '../../src/validator.js';

const validate = makeValidator();

const salesCrmDomain = {
  roles: {
    sdr: { canExecute: '*' },
    ae: { canExecute: '*' },
    manager: { canExecute: '*' },
  },
  entities: { Lead: { fields: {} } },
  intents: {},
};

const effect = { alpha: 'create', entity: 'Lead', fields: { id: 'l-1', name: 'Acme' } };

describe('validator', () => {
  it('unknown role, не owner → unknown_role', () => {
    const res = validate(effect, salesCrmDomain, { userId: 'u', role: 'admin' });
    expect(res).toEqual({ ok: false, reason: 'unknown_role' });
  });

  it('role "owner" не объявлена в ontology → bypass (tenant-owner)', () => {
    const res = validate(effect, salesCrmDomain, { userId: 'u', role: 'owner' });
    expect(res).toEqual({ ok: true });
  });

  it('role "owner" ЕСТЬ в ontology → ontology-декларация побеждает bypass', () => {
    const domainWithOwner = {
      ...salesCrmDomain,
      roles: {
        ...salesCrmDomain.roles,
        owner: { canExecute: ['create_deal'] }, // специально рестрикт
      },
    };
    // Effect без context.intent → проходит thin check (intentName undefined)
    const res = validate(effect, domainWithOwner, { userId: 'u', role: 'owner' });
    expect(res.ok).toBe(true);
  });

  it('объявленная role с canExecute whitelist → non-whitelisted intent отклоняется', () => {
    const restrictedDomain = {
      ...salesCrmDomain,
      roles: { sdr: { canExecute: ['create_lead'] } },
    };
    const e = { ...effect, context: { intent: 'create_deal' } };
    const res = validate(e, restrictedDomain, { userId: 'u', role: 'sdr' });
    expect(res).toEqual({ ok: false, reason: 'role_cannot_execute' });
  });

  it('существующая role с canExecute: "*" → ok', () => {
    const res = validate(effect, salesCrmDomain, { userId: 'u', role: 'sdr' });
    expect(res).toEqual({ ok: true });
  });

  // Nested-shape fallback: legacy tenants на диске держат domain.json в виде
  // {ONTOLOGY, INTENTS, PROJECTIONS} вместо flat {roles, entities, intents}.
  // Validator читает roles из обоих мест — иначе unknown_role для владельцев
  // таких tenants.
  describe('nested-shape fallback (legacy tenants)', () => {
    const nestedDomain = {
      ONTOLOGY: {
        roles: {
          sdr: { canExecute: '*' },
          ae: { canExecute: '*' },
        },
        entities: { Lead: { fields: {} } },
      },
      INTENTS: {},
      PROJECTIONS: {},
    };

    it('читает roles из ONTOLOGY.roles когда flat .roles отсутствует', () => {
      const res = validate(effect, nestedDomain, { userId: 'u', role: 'sdr' });
      expect(res).toEqual({ ok: true });
    });

    it('unknown role даже с nested fallback → unknown_role', () => {
      const res = validate(effect, nestedDomain, { userId: 'u', role: 'admin' });
      expect(res).toEqual({ ok: false, reason: 'unknown_role' });
    });

    it('owner bypass работает на nested domain', () => {
      const res = validate(effect, nestedDomain, { userId: 'u', role: 'owner' });
      expect(res).toEqual({ ok: true });
    });

    it('flat .roles побеждает ONTOLOGY.roles (forward compat)', () => {
      const mixed = {
        roles: { sdr: { canExecute: ['create_lead'] } },
        ONTOLOGY: { roles: { sdr: { canExecute: '*' } } },
      };
      const e = { ...effect, context: { intent: 'create_deal' } };
      const res = validate(e, mixed, { userId: 'u', role: 'sdr' });
      expect(res).toEqual({ ok: false, reason: 'role_cannot_execute' });
    });
  });
});
