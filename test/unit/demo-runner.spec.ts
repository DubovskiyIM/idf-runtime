import { describe, expect, it } from 'vitest';
import { demoRunToolUseLoop } from '../../src/agent/demo-runner.js';

type Event = { kind: string; [k: string]: unknown };

async function run(task: string): Promise<{ events: Event[]; calls: any[] }> {
  const events: Event[] = [];
  const calls: any[] = [];
  await demoRunToolUseLoop({
    task,
    systemPrompt: '',
    onEvent: (e) => events.push(e as Event),
    tools: {
      exec_intent: async (input) => {
        calls.push(input);
        return { ok: true, intentId: input.intentId, effectIds: ['e-1'] };
      },
      observe_world: async () => ({ Portfolio: [{ id: 'p-test' }] }),
      wait_for_signal: async () => ({ waited: 0 }),
    },
  });
  return { events, calls };
}

describe('demo-runner', () => {
  it('matches «купи 5 TSLA на 5000» (cyrillic regex без /u flag)', async () => {
    const { events, calls } = await run('купи 5 TSLA на 5000');
    expect(calls).toHaveLength(1);
    expect(calls[0].intentId).toBe('agent_execute_preapproved_order');
    expect(calls[0].params).toMatchObject({
      direction: 'buy',
      quantity: 5,
      total: 5000,
      assetId: 'asset-tsla',
      assetType: 'stock',
      portfolioId: 'p-test',
    });
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('matches «продай 3 NVDA за 1500»', async () => {
    const { calls } = await run('продай 3 NVDA за 1500');
    expect(calls[0].params.direction).toBe('sell');
    expect(calls[0].params.assetId).toBe('asset-nvda');
  });

  it('matches «купи 2 BTC на 100000» (crypto — preapproval должен reject)', async () => {
    const { calls } = await run('купи 2 BTC на 100000');
    expect(calls[0].params.assetType).toBe('crypto');
  });

  it('matches «пересчитай риск-профиль»', async () => {
    const { calls } = await run('пересчитай риск-профиль');
    expect(calls[0].intentId).toBe('agent_recompute_risk_score');
    expect(calls[0].params.portfolioId).toBe('p-test');
  });

  it('matches «отчёт по риску» → reportType=risk', async () => {
    const { calls } = await run('отчёт по риску');
    expect(calls[0].intentId).toBe('agent_generate_report');
    expect(calls[0].params.reportType).toBe('risk');
  });

  it('returns clarification on unknown task', async () => {
    const { events, calls } = await run('расскажи анекдот');
    expect(calls).toHaveLength(0);
    expect(events[0]?.kind).toBe('thinking');
    expect(String(events[0]?.text)).toMatch(/Не понял задачу/);
    expect(events.at(-1)?.kind).toBe('done');
  });
});
