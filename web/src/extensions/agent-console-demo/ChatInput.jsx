import React, { useState } from "react";

export default function ChatInput({ onSubmit, disabled }) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) {
          onSubmit(value);
          setValue("");
        }
      }}
      style={{
        display: "flex",
        gap: 8,
        padding: 12,
        borderTop: "1px solid var(--idf-border, #e5e5e5)",
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Дай задачу агенту..."
        disabled={disabled}
        style={{
          flex: 1,
          padding: "8px 12px",
          borderRadius: 6,
          border: "1px solid var(--idf-border, #e5e5e5)",
          background: "var(--idf-surface, #fff)",
          color: "var(--idf-text, #111)",
        }}
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        style={{
          padding: "8px 16px",
          borderRadius: 6,
          background: "var(--idf-primary, #1677ff)",
          color: "white",
          border: "none",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled || !value.trim() ? 0.5 : 1,
        }}
      >
        {disabled ? "…" : "Отправить"}
      </button>
    </form>
  );
}
