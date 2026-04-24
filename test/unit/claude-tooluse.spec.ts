import { describe, it, expect, vi } from 'vitest';
import { runToolUseLoop } from '../../src/agent/claude-tooluse';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

function mockChild(stdoutLines: string[]) {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => {
    for (const l of stdoutLines) child.stdout.write(l + '\n');
    child.stdout.end();
    child.emit('close', 0);
  });
  return child;
}

describe('runToolUseLoop', () => {
  it('emits thinking + observation + done events', async () => {
    const spawn = vi.fn(() =>
      mockChild([
        JSON.stringify({ type: 'text_delta', text: 'анализ...' }),
        JSON.stringify({ type: 'tool_use', id: 't1', name: 'observe_world', input: {} }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );
    const events: any[] = [];
    const tools = {
      exec_intent: vi.fn(),
      observe_world: vi.fn(async () => ({ summary: 'portfolio=$x' })),
      wait_for_signal: vi.fn(),
    };
    await runToolUseLoop({
      task: 'do something',
      systemPrompt: 'you are agent',
      tools,
      onEvent: (e) => events.push(e),
      spawn: spawn as any,
      maxCalls: 10,
      timeoutMs: 5000,
    });
    expect(events.find((e) => e.kind === 'thinking')).toBeDefined();
    expect(events.find((e) => e.kind === 'observation')).toBeDefined();
    expect(events.find((e) => e.kind === 'done')).toBeDefined();
    expect(tools.observe_world).toHaveBeenCalled();
  });

  it('emits effect for exec_intent tool_use', async () => {
    const spawn = vi.fn(() =>
      mockChild([
        JSON.stringify({
          type: 'tool_use',
          id: 't1',
          name: 'exec_intent',
          input: { intentId: 'buy', params: { total: 1 } },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );
    const events: any[] = [];
    await runToolUseLoop({
      task: 't',
      systemPrompt: 's',
      tools: {
        exec_intent: async (input: any) => ({ ok: true, intentId: input.intentId }),
        observe_world: async () => ({}),
        wait_for_signal: async () => ({}),
      },
      onEvent: (e) => events.push(e),
      spawn: spawn as any,
      maxCalls: 10,
      timeoutMs: 5000,
    });
    const effect = events.find((e) => e.kind === 'effect');
    expect(effect).toBeDefined();
    expect(effect.result.intentId).toBe('buy');
  });

  it('stops after maxCalls tool calls', async () => {
    const spawn = vi.fn(() =>
      mockChild([
        JSON.stringify({ type: 'tool_use', id: 't1', name: 'exec_intent', input: {} }),
        JSON.stringify({ type: 'tool_use', id: 't2', name: 'exec_intent', input: {} }),
        JSON.stringify({ type: 'tool_use', id: 't3', name: 'exec_intent', input: {} }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );
    const events: any[] = [];
    await runToolUseLoop({
      task: 't',
      systemPrompt: 's',
      tools: {
        exec_intent: async () => ({ ok: true }),
        observe_world: async () => ({}),
        wait_for_signal: async () => ({}),
      },
      onEvent: (e) => events.push(e),
      spawn: spawn as any,
      maxCalls: 2,
      timeoutMs: 5000,
    });
    const limitError = events.find(
      (e) => e.kind === 'error' && String(e.message ?? '').includes('maxCalls'),
    );
    expect(limitError).toBeDefined();
  });
});
