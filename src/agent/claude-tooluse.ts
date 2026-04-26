import { spawn as realSpawn } from 'node:child_process';

export type ToolHandlers = {
  exec_intent: (input: any) => Promise<any>;
  observe_world: (input: any) => Promise<any>;
  wait_for_signal: (input: any) => Promise<any>;
};

export type TurnEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'effect'; result: any }
  | { kind: 'observation'; summary: any }
  | { kind: 'pause'; ms: number }
  | { kind: 'done'; totalCalls: number }
  | { kind: 'error'; message: string };

export type RunOpts = {
  task: string;
  systemPrompt: string;
  tools: ToolHandlers;
  onEvent: (e: TurnEvent) => void;
  spawn?: typeof realSpawn;
  maxCalls?: number;
  timeoutMs?: number;
  claudeBinary?: string;
  model?: string;
};

/**
 * Claude CLI tool-use loop. Spawn'ит `claude --print --output-format stream-json`,
 * парсит NDJSON из stdout, обрабатывает tool_use события через handlers, пишет
 * tool_result обратно в stdin. Выходит при message_stop / maxCalls / timeout.
 *
 * spawn injectable для тестов (mock subprocess с PassThrough streams).
 */
export async function runToolUseLoop(opts: RunOpts): Promise<void> {
  const spawn = opts.spawn ?? realSpawn;
  const maxCalls = opts.maxCalls ?? 10;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const binary = opts.claudeBinary ?? 'claude';
  const model = opts.model ?? 'sonnet';

  // --permission-mode bypassPermissions НЕ используем: под root claude CLI
  // отказывает («--dangerously-skip-permissions cannot be used with root/sudo
  // privileges»). С --disallowed-tools '*' все tools заблокированы — permission
  // prompts невозможны в принципе, поэтому bypass избыточен. Identical с
  // studio/server/sessions/claude-cli.ts (M1.2 path).
  const child: any = spawn(
    binary,
    [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'text',
      '--model',
      model,
      '--append-system-prompt',
      opts.systemPrompt,
      '--disallowed-tools',
      '*',
    ],
    {
      env: {
        ...process.env,
        // IS_SANDBOX=1 — claude CLI знает что мы в изолированном окружении
        // (Docker container с disallowed-tools), permission-flow упрощается.
        IS_SANDBOX: '1',
      },
    },
  );

  child.stdin?.write(opts.task);
  child.stdin?.end?.();

  const timeout = setTimeout(() => {
    opts.onEvent({ kind: 'error', message: 'timeout' });
    child.kill?.('SIGTERM');
  }, timeoutMs);

  let callCount = 0;
  let limitExceeded = false;
  let buf = '';

  await new Promise<void>((resolve) => {
    child.stdout?.on('data', async (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        await handleEvent(evt);
      }
    });
    child.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.on('error', (e: Error) => {
      opts.onEvent({ kind: 'error', message: String(e.message) });
    });

    async function handleEvent(evt: any) {
      if (evt.type === 'text_delta' || evt.type === 'text') {
        opts.onEvent({ kind: 'thinking', text: evt.text ?? '' });
      } else if (evt.type === 'tool_use') {
        if (limitExceeded) return;
        if (callCount >= maxCalls) {
          limitExceeded = true;
          opts.onEvent({ kind: 'error', message: `maxCalls=${maxCalls} exceeded` });
          child.kill?.('SIGTERM');
          return;
        }
        callCount++;
        const handler = (opts.tools as any)[evt.name];
        if (!handler) {
          opts.onEvent({ kind: 'error', message: `unknown_tool:${evt.name}` });
          return;
        }
        try {
          const result = await handler(evt.input ?? {});
          if (evt.name === 'exec_intent') {
            opts.onEvent({ kind: 'effect', result });
          } else if (evt.name === 'observe_world') {
            opts.onEvent({ kind: 'observation', summary: result });
          } else if (evt.name === 'wait_for_signal') {
            opts.onEvent({ kind: 'pause', ms: evt.input?.maxMs ?? 2000 });
          }
          if (child.stdin && child.stdin.writable !== false && !child.stdin.writableEnded) {
            try {
              child.stdin.write(
                JSON.stringify({
                  type: 'tool_result',
                  tool_use_id: evt.id,
                  content: JSON.stringify(result),
                }) + '\n',
              );
            } catch {
              /* stdin closed — ignore */
            }
          }
        } catch (e: any) {
          opts.onEvent({ kind: 'error', message: String(e?.message ?? e) });
        }
      } else if (evt.type === 'message_stop' || evt.type === 'result') {
        opts.onEvent({ kind: 'done', totalCalls: callCount });
      }
    }
  });
}
