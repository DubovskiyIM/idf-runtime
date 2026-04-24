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

  // Regression: до fix'а particles.effects[*].fields игнорировались buildEffects'ом
  // → phase-transitions без параметров (qualify_deal, submit_proposal) молча
  // пропускались, defaults (status:"new" на create_lead) не попадали в effect.
  describe('particles.effects[*].fields merge', () => {
    it('create: mergeит src.fields (дефолты) перед ctx — user-input побеждает', () => {
      const INTENTS = {
        create_lead: {
          α: 'create',
          target: 'Lead',
          particles: {
            effects: [{ α: 'create', target: 'Lead', fields: { status: 'new' } }],
          },
        },
      };
      const [e] = buildEffectsFromIntent(
        'create_lead',
        { name: 'Acme', email: 'a@b.c' },
        INTENTS,
        viewer,
      );
      expect(e.fields.status).toBe('new'); // дефолт из particles
      expect(e.fields.name).toBe('Acme');
      expect(e.fields.email).toBe('a@b.c');
      expect(typeof e.fields.id).toBe('string');
    });

    it('create: ctx побеждает дефолт если передал то же поле', () => {
      const INTENTS = {
        create_lead: {
          α: 'create',
          target: 'Lead',
          particles: {
            effects: [{ α: 'create', target: 'Lead', fields: { status: 'new' } }],
          },
        },
      };
      const [e] = buildEffectsFromIntent(
        'create_lead',
        { name: 'A', status: 'qualified' },
        INTENTS,
        viewer,
      );
      expect(e.fields.status).toBe('qualified');
    });

    it('replace: phase-transition с fields в particles (ctx={id}) — больше не скипается', () => {
      const INTENTS = {
        qualify_deal: {
          α: 'replace',
          target: 'Deal.stage',
          particles: {
            effects: [{ α: 'replace', target: 'Deal.stage', fields: { stage: 'qualified' } }],
          },
        },
      };
      const effects = buildEffectsFromIntent('qualify_deal', { id: 'd-1' }, INTENTS, viewer);
      expect(effects).toHaveLength(1);
      expect(effects[0].alpha).toBe('replace');
      expect(effects[0].entity).toBe('Deal');
      expect(effects[0].fields.id).toBe('d-1');
      expect(effects[0].fields.stage).toBe('qualified');
    });

    it('replace: lose_deal — src.fields.stage + ctx.lossReason (оба попадают)', () => {
      const INTENTS = {
        lose_deal: {
          α: 'replace',
          target: 'Deal.stage',
          particles: {
            effects: [{ α: 'replace', target: 'Deal.stage', fields: { stage: 'lost' } }],
          },
        },
      };
      const [e] = buildEffectsFromIntent(
        'lose_deal',
        { id: 'd-1', lossReason: 'price' },
        INTENTS,
        viewer,
      );
      expect(e.fields.stage).toBe('lost');
      expect(e.fields.lossReason).toBe('price');
    });

    it('replace без value (нет fields ни в particles, ни в ctx) — по-прежнему скипается', () => {
      const INTENTS = {
        advance_stage: {
          α: 'replace',
          target: 'Deal.stage',
        },
      };
      const effects = buildEffectsFromIntent('advance_stage', { id: 'd-1' }, INTENTS, viewer);
      expect(effects).toHaveLength(0);
    });
  });

  describe('reserved ctx keys (entity marker / self-ref id)', () => {
    // SDK renderer передаёт ctx вида `{id, entity: item, ...values}` —
    // `entity` это contextual marker «какая строка была выбрана». До fix'а
    // buildEffects копировал его в fields → каждый replace-turn генерировал
    // fields с вложенным `entity: {...prev}`. Через N turn'ов получали
    // `entity: {entity: {entity: {...}}}` глубиной N.
    it('replace: ctx.entity НЕ попадает в fields', () => {
      const INTENTS = {
        pay_order: {
          α: 'replace',
          target: 'Order.status',
          particles: {
            effects: [{ target: 'Order.status', op: 'replace', fields: { status: 'paid' } }],
          },
        },
      };
      const prevRow = { id: 'o-1', status: 'new', title: 'заказ' };
      const [e] = buildEffectsFromIntent(
        'pay_order',
        { id: 'o-1', entity: prevRow },
        INTENTS,
        viewer,
      );
      expect(e).toBeDefined();
      expect(e.fields.status).toBe('paid');
      expect(e.fields).not.toHaveProperty('entity');
    });

    it('create: ctx.entity НЕ попадает в fields', () => {
      const INTENTS = { create_book: { α: 'create', target: 'Book' } };
      const prevRow = { id: 'b-old', title: 'Другая' };
      const [e] = buildEffectsFromIntent(
        'create_book',
        { title: 'Новая', entity: prevRow },
        INTENTS,
        viewer,
      );
      expect(e.fields.title).toBe('Новая');
      expect(e.fields).not.toHaveProperty('entity');
    });

    it('replace: self-ref id ключ (bookId при entity=Book) НЕ попадает в fields', () => {
      // Shim coerce'ит delete_book в replace-intent с `bookId` в params.
      // Renderer передаёт `{id: item.id, bookId: item.id}` — самореферент.
      // Без skip'а fields.bookId = id → каждый replace повторно дублирует
      // routing-ключ в data.
      const INTENTS = {
        update_book: {
          α: 'replace',
          target: 'Book',
          particles: { effects: [{ target: 'Book', op: 'replace' }] },
        },
      };
      const [e] = buildEffectsFromIntent(
        'update_book',
        { id: 'b-1', bookId: 'b-1', title: 'Новое' },
        INTENTS,
        viewer,
      );
      expect(e.fields.id).toBe('b-1');
      expect(e.fields.title).toBe('Новое');
      expect(e.fields).not.toHaveProperty('bookId');
    });

    it('ctx.entityId skip (backward-compat routing)', () => {
      const INTENTS = {
        update_order: {
          α: 'replace',
          target: 'Order',
          particles: { effects: [{ target: 'Order', op: 'replace' }] },
        },
      };
      const [e] = buildEffectsFromIntent(
        'update_order',
        { entityId: 'o-1', note: 'x' },
        INTENTS,
        viewer,
      );
      expect(e.fields.id).toBe('o-1');
      expect(e.fields).not.toHaveProperty('entityId');
      expect(e.fields.note).toBe('x');
    });

    it('regression: 3 последовательных replace не накапливают entity-wrap', () => {
      const INTENTS = {
        pay_order: {
          α: 'replace',
          target: 'Order.status',
          particles: {
            effects: [{ target: 'Order.status', op: 'replace', fields: { status: 'paid' } }],
          },
        },
      };
      let row: Record<string, unknown> = { id: 'o-1', status: 'new' };
      for (let i = 0; i < 3; i++) {
        const [e] = buildEffectsFromIntent(
          'pay_order',
          { id: 'o-1', entity: row },
          INTENTS,
          viewer,
        );
        expect(e.fields).not.toHaveProperty('entity');
        row = { ...e.fields };
      }
    });
  });
});
