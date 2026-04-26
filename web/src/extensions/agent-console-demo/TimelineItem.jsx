import React from "react";

const REASON_LABELS = {
  preapproval_denied: "Preapproval не разрешает",
  preapproval_denied_maxAmount: "Превышен максимальный размер ордера",
  preapproval_denied_csvInclude: "Тип актива не разрешён",
  preapproval_denied_dailySum: "Превышен дневной лимит",
  preapproval_denied_notExpired: "Preapproval истёк",
  preapproval_denied_active: "Preapproval не активен",
  invariant_violated: "Нарушено формальное правило",
  intent_not_permitted: "Intent не разрешён для роли",
  intent_not_found: "Intent не найден",
  no_effects_from_intent: "Intent не произвёл эффектов",
  timeout: "Таймаут",
};

function reasonLabel(reason, failedCheck) {
  const combinedKey = failedCheck ? `${reason}_${failedCheck}` : reason;
  return REASON_LABELS[combinedKey] ?? REASON_LABELS[reason] ?? reason;
}

export default function TimelineItem({ event }) {
  const base = {
    padding: "8px 12px",
    margin: "4px 0",
    borderRadius: 6,
    fontSize: 14,
  };

  switch (event.kind) {
    case "thinking":
      return (
        <div
          style={{
            ...base,
            background: "var(--idf-surface-subtle, #f5f5f5)",
            color: "var(--idf-text-secondary, #555)",
          }}
        >
          🤔 {event.text}
        </div>
      );
    case "effect": {
      const ok = event.result?.ok;
      const bg = ok
        ? "var(--idf-success-bg, #e6f7e6)"
        : "var(--idf-danger-bg, #fde8e8)";
      const color = ok
        ? "var(--idf-success, #1b873f)"
        : "var(--idf-danger, #c92a2a)";
      return (
        <div style={{ ...base, background: bg, color }}>
          <strong>{ok ? "✓ accepted" : "✗ rejected"}</strong>
          {" · "}
          {event.result?.intentId ?? "—"}
          {!ok && event.result?.reason && (
            <span> · {reasonLabel(event.result.reason, event.result.failedCheck)}</span>
          )}
        </div>
      );
    }
    case "observation":
      return (
        <div style={{ ...base, fontStyle: "italic", opacity: 0.7 }}>
          👁 {JSON.stringify(event.summary).slice(0, 80)}
        </div>
      );
    case "pause":
      return (
        <div style={{ ...base, opacity: 0.5 }}>⏸ пауза {event.ms}ms</div>
      );
    case "error":
      return (
        <div
          style={{
            ...base,
            background: "var(--idf-danger-bg, #fde8e8)",
            color: "var(--idf-danger, #c92a2a)",
          }}
        >
          ⚠ {event.message}
        </div>
      );
    case "done":
      return (
        <div style={{ ...base, textAlign: "center", opacity: 0.5 }}>
          — завершено ({event.totalCalls} actions) —
        </div>
      );
    default:
      return null;
  }
}
