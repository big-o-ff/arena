"use client";

import { useState } from "react";

/**
 * Garbage Collection sabotage trigger.
 *
 * The cost is kept in sync with `sabotage.views.GC_HP_COST`. It was 80 HP of a
 * 100 HP pool, which made the ability self-defeating — the winner is whoever has
 * more HP left, so using it handed over the match.
 */
export const GC_HP_COST = 15;
const GC_DURATION_SECONDS = 5;

export function GCButton({
  gcUsed,
  myHp,
  battleComplete,
  onConfirm,
}: {
  gcUsed: boolean;
  myHp: number;
  battleComplete: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // The server refuses a spend that would reduce you to zero, so mirror that.
  const insufficient = myHp <= GC_HP_COST;
  const disabled = gcUsed || battleComplete || insufficient;

  if (confirming) {
    return (
      <div
        style={{
          border: "1px solid rgba(255,68,68,0.4)",
          borderRadius: "6px",
          padding: "10px",
          background: "rgba(255,68,68,0.05)",
        }}
      >
        <p
          style={{
            color: "#ff4444",
            fontSize: "11px",
            marginBottom: "8px",
            fontFamily: "monospace",
          }}
        >
          This costs {GC_HP_COST} HP. Confirm?
        </p>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onConfirm();
            }}
            style={{
              flex: 1,
              background: "rgba(255,68,68,0.15)",
              border: "1px solid rgba(255,68,68,0.5)",
              borderRadius: "4px",
              color: "#ff4444",
              fontSize: "10px",
              padding: "5px 4px",
              cursor: "pointer",
              fontFamily: "monospace",
            }}
          >
            YES — ACTIVATE
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            style={{
              background: "transparent",
              border: "1px solid rgba(200,211,224,0.2)",
              borderRadius: "4px",
              color: "rgba(200,211,224,0.5)",
              fontSize: "10px",
              padding: "5px 8px",
              cursor: "pointer",
              fontFamily: "monospace",
            }}
          >
            cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => !disabled && setConfirming(true)}
        disabled={disabled}
        style={{
          width: "100%",
          background: "transparent",
          border: `1px solid ${
            disabled ? "rgba(200,211,224,0.15)" : "rgba(255,68,68,0.5)"
          }`,
          borderRadius: "6px",
          color: disabled ? "rgba(200,211,224,0.25)" : "#ff4444",
          fontSize: "11px",
          padding: "8px 12px",
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "monospace",
          letterSpacing: "0.08em",
          transition: "all 0.2s",
          textAlign: "center",
        }}
      >
        {gcUsed ? "GC used" : "☠ GARBAGE COLLECTION"}
      </button>
      <p
        style={{
          fontSize: "10px",
          color: "rgba(200,211,224,0.25)",
          marginTop: "4px",
          textAlign: "center",
          fontFamily: "monospace",
        }}
      >
        {gcUsed
          ? ""
          : insufficient
          ? "insufficient HP"
          : `costs ${GC_HP_COST} HP · blanks opponent ${GC_DURATION_SECONDS}s`}
      </p>
    </div>
  );
}
