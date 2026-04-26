import React, { useEffect, useRef } from "react";
import ChatInput from "./ChatInput.jsx";
import TimelineItem from "./TimelineItem.jsx";

/**
 * Agent Console archetype — UI для LLM-агента через tool-use loop.
 *
 * Props:
 *   - projection: { title?, id }
 *   - events: TurnEvent[] (thinking/effect/observation/pause/error/done)
 *   - onSubmit: (task: string) => void
 *   - isRunning: boolean
 *   - onReset?: () => void
 */
export default function AgentConsole({
  projection = {},
  events = [],
  onSubmit,
  isRunning,
  onReset,
}) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events.length]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "1px solid var(--idf-border, #e5e5e5)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{projection.title ?? "Agent"}</h2>
        {onReset && (
          <button
            onClick={onReset}
            disabled={isRunning}
            style={{
              padding: "4px 12px",
              borderRadius: 4,
              border: "1px solid var(--idf-border, #d9d9d9)",
              background: "transparent",
              cursor: isRunning ? "default" : "pointer",
              opacity: isRunning ? 0.5 : 1,
            }}
          >
            Reset
          </button>
        )}
      </header>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {events.length === 0 && !isRunning && (
          <div style={{ opacity: 0.5, textAlign: "center", marginTop: 40 }}>
            Дай агенту задачу — например: «оптимизируй портфель»
          </div>
        )}
        {events.map((e, i) => (
          <TimelineItem key={i} event={e} />
        ))}
        {isRunning && events.at(-1)?.kind !== "done" && (
          <div style={{ opacity: 0.5, padding: 8 }}>…</div>
        )}
      </div>
      <ChatInput onSubmit={onSubmit} disabled={isRunning} />
    </div>
  );
}
