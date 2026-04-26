import { useCallback, useState, useRef, useEffect } from 'react';
import AgentConsole from './AgentConsole.jsx';

type TurnEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'effect'; result: { ok: boolean; intentId?: string; reason?: string; failedCheck?: string; effectIds?: string[] } }
  | { kind: 'observation'; summary: unknown }
  | { kind: 'pause'; ms: number }
  | { kind: 'error'; message: string }
  | { kind: 'done'; totalCalls: number };

type Props = {
  projection: { id?: string; title?: string } | null;
  /** Slug плейсхолдер для URL — backend всё равно резолвит tenant из env. */
  tenantSlug?: string;
  onEffectApplied?: () => void;
};

/**
 * Host-extension контейнер для AgentConsole.
 *
 * Архитектурно: НЕ archetype (см. backlog `format-rule-archetype-closed-enum`).
 * Archetype — это структурный shape проекции (catalog/detail/feed/form/canvas/
 * dashboard/wizard), composable across 4 reader'ов. AgentConsole — это
 * interaction modality (chat-стиль над agent API), живёт в host-extension layer.
 *
 * Wires:
 *   - POST /api/agent/:slug/console/turn { task } — SSE stream
 *   - parses `data: <json>\n\n` events → TurnEvent[]
 *   - на done/error закрывает stream
 *   - после "effect" event'ов триггерит onEffectApplied (host обновляет world)
 */
export default function AgentConsoleExtension({
  projection,
  tenantSlug = 'tenant',
  onEffectApplied,
}: Props) {
  const [events, setEvents] = useState<TurnEvent[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleSubmit = useCallback(
    async (task: string) => {
      if (isRunning) return;
      setEvents([]);
      setIsRunning(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(tenantSlug)}/console/turn`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ task }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const text = !res.ok ? await res.text().catch(() => '') : 'no_body';
          setEvents((prev) => [
            ...prev,
            { kind: 'error', message: `HTTP ${res.status}: ${text || 'agent unreachable'}` },
          ]);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let sawEffect = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIdx: number;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                const event = JSON.parse(payload) as TurnEvent;
                setEvents((prev) => [...prev, event]);
                if (event.kind === 'effect') sawEffect = true;
              } catch (err) {
                console.warn('[AgentConsoleExtension] cannot parse SSE payload', payload, err);
              }
            }
          }
        }

        if (sawEffect) onEffectApplied?.();
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        const message = e instanceof Error ? e.message : String(e);
        setEvents((prev) => [...prev, { kind: 'error', message }]);
      } finally {
        setIsRunning(false);
        abortRef.current = null;
      }
    },
    [isRunning, tenantSlug, onEffectApplied],
  );

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setEvents([]);
    setIsRunning(false);
  }, []);

  return (
    <AgentConsole
      projection={projection ?? {}}
      events={events}
      onSubmit={handleSubmit}
      isRunning={isRunning}
      onReset={handleReset}
    />
  );
}
