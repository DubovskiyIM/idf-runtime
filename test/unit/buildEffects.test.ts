import { describe, expect, it } from 'vitest';
import { buildEffectsFromIntent } from '../../web/src/buildEffects';

const viewer = { id: 'user-1', name: 'Алиса' };

describe('buildEffectsFromIntent', () => {
  describe('create', () => {
    it('flat α+target (без particles) — генерит create effect с uuid', () => {
      const INTENTS = {
        create_lead: { α: 'create', target: 'Lead' },
      };
      const effects = buildEffectsFromIntent(
        'create_lead',
        { name: 'Acme', email: 'a@b.c', source: 'inbound' },
        INTENTS,
        viewer,
      );
      expect(effects).toHaveLength(1);
      expect(effects[0].alpha).toBe('create');
      expect(effects[0].entity).toBe('Lead');
      expect(effects[0].fields.name).toBe('Acme');
      expect(effects[0].fields.email).toBe('a@b.c');
      expect(typeof effects[0].fields.id).toBe('string');
      expect(effects[0].context?.actor).toBe('user-1');
    });

    it('particles.effects[] (после normalize) — использует их вместо flat', () => {
      const INTENTS = {
        create_deal: {
          α: 'create',
          target: 'Deal',
          creates: 'Deal',
          particles: { effects: [{ target: 'Deal', op: 'create', α: 'create' }] },
        },
      };
      const [effect] = buildEffectsFromIntent('create_deal', { title: 't', amount: 1 }, INTENTS, viewer);
      expect(effect.alpha).toBe('create');
      expect(effect.entity).toBe('Deal');
      expect(effect.fields.title).toBe('t');
    });

    it('использует ctx.id если указан (вместо uuid)', () => {
      const INTENTS = { create_user: { α: 'create', target: 'User' } };
      const [e] = buildEffectsFromIntent('create_user', { id: 'u-123', name: 'A' }, INTENTS, viewer);
      expect(e.fields.id).toBe('u-123');
    });

    it('восстанавливает CapitalCase из lowercase target', () => {
      const INTENTS = { create_task: { α: 'create', target: 'task', creates: 'Task' } };
      const [e] = buildEffectsFromIntent('create_task', {}, INTENTS, viewer);
      expect(e.entity).toBe('Task');
    });

    it('восстанавливает singular из pluralized lowercase', () => {
      const INTENTS = {
        create_entry: { particles: { effects: [{ target: 'entries', op: 'add' }] } },
      };
      const [e] = buildEffectsFromIntent('create_entry', {}, INTENTS, viewer);
      expect(e.entity).toBe('Entry');
    });
  });

  describe('replace', () => {
    it('dotted target + ctx.id + ctx.field=value — генерит replace', () => {
      const INTENTS = {
        update_lead_status: { α: 'replace', target: 'Lead.status' },
      };
      const [e] = buildEffectsFromIntent(
        'update_lead_status',
        { id: 'l-1', status: 'qualified' },
        INTENTS,
        viewer,
      );
      expect(e.alpha).toBe('replace');
      expect(e.entity).toBe('Lead');
      expect(e.fields).toEqual({ id: 'l-1', status: 'qualified' });
    });

    it('dotted target без value в ctx — пропускает (возвращает пустой массив)', () => {
      const INTENTS = { qualify_lead: { α: 'replace', target: 'Lead.status' } };
      const effects = buildEffectsFromIntent('qualify_lead', { id: 'l-1' }, INTENTS, viewer);
      expect(effects).toHaveLength(0);
    });

    it('non-dotted replace — берёт все ctx fields', () => {
      const INTENTS = { update_user: { α: 'replace', target: 'User' } };
      const [e] = buildEffectsFromIntent(
        'update_user',
        { id: 'u-1', name: 'B', email: 'b@b.c' },
        INTENTS,
        viewer,
      );
      expect(e.fields).toEqual({ id: 'u-1', name: 'B', email: 'b@b.c' });
    });

    it('без ctx.id → пропускается', () => {
      const INTENTS = { update_user: { α: 'replace', target: 'User' } };
      const effects = buildEffectsFromIntent('update_user', { name: 'B' }, INTENTS, viewer);
      expect(effects).toHaveLength(0);
    });

    it('<entity>Id ctx ключ — распознаётся', () => {
      const INTENTS = { update_lead_status: { α: 'replace', target: 'Lead.status' } };
      const [e] = buildEffectsFromIntent(
        'update_lead_status',
        { leadId: 'l-9', status: 'won' },
        INTENTS,
        viewer,
      );
      expect(e.fields.id).toBe('l-9');
    });
  });

  describe('remove', () => {
    it('ctx.id + target — генерит remove', () => {
      const INTENTS = { delete_lead: { α: 'remove', target: 'Lead' } };
      const [e] = buildEffectsFromIntent('delete_lead', { id: 'l-1' }, INTENTS, viewer);
      expect(e.alpha).toBe('remove');
      expect(e.entity).toBe('Lead');
      expect(e.fields).toEqual({ id: 'l-1' });
    });
  });

  describe('edge cases', () => {
    it('unknown intent — []', () => {
      const effects = buildEffectsFromIntent('nope', {}, {}, viewer);
      expect(effects).toEqual([]);
    });

    it('intent без α/particles — []', () => {
      const INTENTS = { read_leads: { target: 'Lead' } };
      const effects = buildEffectsFromIntent('read_leads', {}, INTENTS, viewer);
      expect(effects).toEqual([]);
    });

    it('без viewer — context.actor отсутствует, ничего не падает', () => {
      const INTENTS = { create_lead: { α: 'create', target: 'Lead' } };
      const [e] = buildEffectsFromIntent('create_lead', { name: 'A' }, INTENTS, null);
      expect(e.alpha).toBe('create');
      expect(e.context?.actor).toBeUndefined();
    });

    it('intent.context прокидывается (например __irr)', () => {
      const INTENTS = {
        win_deal: {
          α: 'replace',
          target: 'Deal.stage',
          context: { __irr: { point: 'high', reason: 'r' } },
        },
      };
      const [e] = buildEffectsFromIntent('win_deal', { id: 'd-1', stage: 'won' }, INTENTS, viewer);
      expect((e.context as any).__irr).toEqual({ point: 'high', reason: 'r' });
      expect((e.context as any).actor).toBe('user-1');
    });
  });
});
