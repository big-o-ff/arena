"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-xs text-noir-terminal/40">
      Loading editor…
    </div>
  ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type RunResult = {
  passed: boolean;
  output: string;
  expected: string;
  execution_time_ms: number;
  stderr?: string | null;
};

type Problem = {
  id: number;
  title: string;
  description: string;
  difficulty: string;
  input_format: string;
  output_format: string;
  constraints: string;
  sample_input: string;
  sample_output: string;
};

type Props = {
  // Battle context
  battleId: string;
  problems: Problem[];
  selectedProblemIdx: number;
  onSelectProblem: (idx: number) => void;
  solvedProblems: Set<number>;   // set of problem ids

  // My editor
  myCode: string;
  onChangeMyCode: (code: string) => void;
  language: string;
  onChangeLanguage: (lang: string) => void;

  // Opponent feed
  opponentCode: string;

  // Sabot overlay states
  gcActive: boolean;
  fogActive: boolean;

  // Actions
  onRun: (code: string, language: string, problemId: number) => Promise<RunResult | null>;
  onSubmit: () => void;
  isSubmitting: boolean;
  battleComplete: boolean;

  // GC sabotage
  myHp: number;
  gcUsed: boolean;
  onGC: () => void;
};

// ---------------------------------------------------------------------------
// Difficulty badge colours
// ---------------------------------------------------------------------------
const diffColor = (d: string) => {
  if (d === "easy") return "#00ff88";
  if (d === "medium") return "#ffa500";
  return "#ff4444";
};

const diffLabel = (d: string) => d.toUpperCase();

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function BattleEditors({
  battleId,
  problems,
  selectedProblemIdx,
  onSelectProblem,
  solvedProblems,
  myCode,
  onChangeMyCode,
  language,
  onChangeLanguage,
  opponentCode,
  gcActive,
  fogActive,
  onRun,
  onSubmit,
  isSubmitting,
  battleComplete,
  myHp,
  gcUsed,
  onGC,
}: Props) {
  const monacoLanguage =
    language === "cpp" ? "cpp" : language === "javascript" ? "javascript" : "python";

  const selectedProblem = problems[selectedProblemIdx] ?? null;

  // ---- Middle panel tab ----
  const [middleTab, setMiddleTab] = useState<"problem" | "opponent">("problem");

  // ---- Run state ----
  const [isRunning, setIsRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runCooldown, setRunCooldown] = useState(false);

  const handleClearTerminal = useCallback(() => {
    setRunResult(null);
    // Keep cooldown behavior; user can still run again after cooldown window.
  }, []);

  // ---- GC confirmation ----
  const [gcConfirm, setGcConfirm] = useState(false);

  // ---- Debounced code update sender ----
  const wsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Editor change: forward to parent + debounce WS send ----
  // The parent holds the WS ref; we call a callback prop instead.
  // In page.tsx we wire this to the actual WS send.
  // (onChangeMyCode already does this via the page-level handler)

  const handleRun = useCallback(async () => {
    if (!selectedProblem || isRunning || runCooldown) return;
    setIsRunning(true);
    setRunResult(null);
    try {
      const result = await onRun(myCode, language, selectedProblem.id);
      if (result) setRunResult(result);
    } finally {
      setIsRunning(false);
      // 3-second cooldown
      setRunCooldown(true);
      setTimeout(() => setRunCooldown(false), 3000);
    }
  }, [selectedProblem, isRunning, runCooldown, myCode, language, onRun]);

  const handleGCConfirm = useCallback(() => {
    setGcConfirm(false);
    onGC();
  }, [onGC]);

  const gcAllowed = myHp >= 80 && !gcUsed && !battleComplete;
  const gcInsufficient = myHp < 80 && !gcUsed;

  // ---- Reset run result when problem changes ----
  useEffect(() => {
    setRunResult(null);
    setRunCooldown(false);
  }, [selectedProblemIdx]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "40% 35% 25%",
        height: "calc(100vh - 120px)",
        gap: "8px",
        overflow: "hidden",
      }}
    >
      {/* ================================================================
          LEFT PANEL — Code Editor
      ================================================================= */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: "rgba(10,12,16,0.95)",
          border: "1px solid rgba(0,255,136,0.15)",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid rgba(0,255,136,0.1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <span style={{ color: "#00ff88", fontSize: "11px", letterSpacing: "0.2em", fontFamily: "monospace" }}>
            your editor // arena
          </span>
          {/* Language selector */}
          <select
            value={language}
            onChange={(e) => onChangeLanguage(e.target.value)}
            style={{
              background: "rgba(0,255,136,0.05)",
              border: "1px solid rgba(0,255,136,0.2)",
              borderRadius: "4px",
              color: "#c8d3e0",
              fontSize: "11px",
              padding: "2px 6px",
              cursor: "pointer",
              outline: "none",
            }}
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
            <option value="cpp">C++</option>
          </select>
        </div>

        {/* Monaco Editor */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {/* GC overlay */}
          {gcActive && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 30,
                background: "rgba(10,12,16,0.97)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
              }}
            >
              <span style={{ fontSize: "32px" }}>☠</span>
              <span style={{ color: "#ff4444", fontSize: "13px", fontWeight: "bold", letterSpacing: "0.1em" }}>
                GARBAGE COLLECTION
              </span>
              <span style={{ color: "rgba(200,211,224,0.4)", fontSize: "11px" }}>
                IDE blanked — your buffer is safe
              </span>
            </div>
          )}

          {/* Fog overlay */}
          {fogActive && !gcActive && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 20,
                background: "rgba(10,12,16,0.6)",
                backdropFilter: "blur(2px)",
                pointerEvents: "none",
              }}
            />
          )}

          <MonacoEditor
            height="100%"
            language={monacoLanguage}
            value={myCode}
            theme="vs-dark"
            onChange={(val) => onChangeMyCode(val ?? "")}
            options={{
              minimap: { enabled: false },
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              fontSize: 13,
              smoothScrolling: true,
              scrollBeyondLastLine: false,
              padding: { top: 8 },
            }}
          />
        </div>

        {/* Terminal view (sandboxed stdout/stderr) */}
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid rgba(0,255,136,0.1)",
            fontSize: "11px",
            fontFamily: "monospace",
            flexShrink: 0,
            background: "rgba(8,10,14,0.6)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <div style={{ color: "#00ff88", letterSpacing: "0.12em", textTransform: "uppercase" }}>
              Terminal (sandbox)
            </div>
            <button
              type="button"
              onClick={handleClearTerminal}
              disabled={isRunning}
              style={{
                background: "transparent",
                border: "1px solid rgba(200,211,224,0.18)",
                borderRadius: "4px",
                color: isRunning ? "rgba(200,211,224,0.25)" : "rgba(200,211,224,0.6)",
                fontSize: "10px",
                padding: "4px 8px",
                cursor: isRunning ? "not-allowed" : "pointer",
                fontFamily: "monospace",
              }}
            >
              Clear
            </button>
          </div>

          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid rgba(200,211,224,0.08)",
              borderRadius: "6px",
              background: "rgba(0,0,0,0.35)",
              padding: "10px 10px",
              color: "rgba(200,211,224,0.9)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.45,
            }}
          >
            {isRunning ? (
              <span style={{ color: "rgba(200,211,224,0.55)" }}>Running in sandbox...</span>
            ) : runResult ? (
              <>
                <div style={{ marginBottom: 8, color: "rgba(0,255,136,0.7)" }}>
                  $ run sample
                </div>
                <div style={{ marginBottom: 8, color: "rgba(200,211,224,0.65)" }}>
                  stdin:
                  {"\n"}
                  {selectedProblem?.sample_input || "(empty)"}
                </div>
                <div style={{ marginBottom: 8 }}>
                  stdout:
                  {"\n"}
                  {runResult.output || "(empty)"}
                </div>
                {runResult.stderr ? (
                  <div style={{ marginBottom: 8, color: "rgba(255,165,0,0.9)" }}>
                    stderr:
                    {"\n"}
                    {runResult.stderr}
                  </div>
                ) : null}
                <div
                  style={{
                    marginTop: 10,
                    color: runResult.passed ? "#00ff88" : "#ff4444",
                    fontWeight: 700,
                  }}
                >
                  {runResult.passed ? "PASS" : "FAIL"} · {runResult.execution_time_ms}ms
                  {"  "}
                  <span style={{ color: "rgba(200,211,224,0.45)", fontWeight: 500 }}>
                    (expected: {runResult.expected})
                  </span>
                </div>
              </>
            ) : (
              <span style={{ color: "rgba(200,211,224,0.35)" }}>No terminal output yet. Click “▷ Run (sample)”.</span>
            )}
          </div>
        </div>

        {/* Bottom action bar */}
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid rgba(0,255,136,0.1)",
            display: "flex",
            gap: "8px",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {/* RUN button */}
          <button
            type="button"
            onClick={handleRun}
            disabled={isRunning || runCooldown || battleComplete || !selectedProblem}
            style={{
              background: "transparent",
              border: "1px solid rgba(200,211,224,0.3)",
              borderRadius: "4px",
              color: isRunning || runCooldown ? "rgba(200,211,224,0.3)" : "rgba(200,211,224,0.7)",
              fontSize: "11px",
              padding: "5px 14px",
              cursor: isRunning || runCooldown ? "not-allowed" : "pointer",
              fontFamily: "monospace",
              letterSpacing: "0.05em",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {isRunning ? (
              <>
                <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
                Running…
              </>
            ) : runCooldown ? (
              "Run (wait…)"
            ) : (
              "▷ Run (sample)"
            )}
          </button>

          {/* SUBMIT button */}
          <button
            type="button"
            onClick={onSubmit}
            disabled={
              isSubmitting ||
              battleComplete ||
              !selectedProblem ||
              solvedProblems.has(selectedProblem?.id ?? -1)
            }
            style={{
              background: "transparent",
              border: `1px solid ${
                isSubmitting || battleComplete || solvedProblems.has(selectedProblem?.id ?? -1)
                  ? "rgba(200,211,224,0.2)"
                  : "#00ff88"
              }`,
              borderRadius: "4px",
              color:
                isSubmitting || battleComplete || solvedProblems.has(selectedProblem?.id ?? -1)
                  ? "rgba(200,211,224,0.3)"
                  : "#00ff88",
              fontSize: "11px",
              padding: "5px 14px",
              cursor:
                isSubmitting || battleComplete || solvedProblems.has(selectedProblem?.id ?? -1)
                  ? "not-allowed"
                  : "pointer",
              fontFamily: "monospace",
              letterSpacing: "0.05em",
              fontWeight: "600",
              transition: "all 0.2s",
              flex: 1,
            }}
          >
            {isSubmitting
              ? "Submitting…"
              : solvedProblems.has(selectedProblem?.id ?? -1)
              ? "✓ Solved"
              : "Submit"}
          </button>
        </div>
      </div>

      {/* ================================================================
          MIDDLE PANEL — Problem Statement / Opponent Feed
      ================================================================= */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: "rgba(10,12,16,0.95)",
          border: "1px solid rgba(0,255,136,0.15)",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid rgba(0,255,136,0.1)",
            flexShrink: 0,
          }}
        >
          {(["problem", "opponent"] as const).map((tab) => (
            <button
              type="button"
              key={tab}
              onClick={() => setMiddleTab(tab)}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                borderBottom: middleTab === tab ? "2px solid #00ff88" : "2px solid transparent",
                color: middleTab === tab ? "#00ff88" : "rgba(200,211,224,0.4)",
                fontSize: "10px",
                fontFamily: "monospace",
                letterSpacing: "0.15em",
                padding: "10px 8px",
                cursor: "pointer",
                transition: "color 0.2s",
                textTransform: "uppercase",
              }}
            >
              {tab === "problem" ? "Problem Statement" : "Opponent Feed"}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px" }}>
          {middleTab === "problem" ? (
            selectedProblem ? (
              <div style={{ fontFamily: "sans-serif" }}>
                {/* Difficulty badge */}
                <div style={{ marginBottom: "8px" }}>
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: "600",
                      color: diffColor(selectedProblem.difficulty),
                      border: `1px solid ${diffColor(selectedProblem.difficulty)}`,
                      borderRadius: "3px",
                      padding: "2px 8px",
                      letterSpacing: "0.1em",
                    }}
                  >
                    {diffLabel(selectedProblem.difficulty)}
                  </span>
                </div>

                {/* Title */}
                <h2
                  style={{
                    color: "#c8d3e0",
                    fontSize: "16px",
                    fontWeight: "700",
                    fontFamily: "monospace",
                    marginBottom: "12px",
                    lineHeight: 1.3,
                  }}
                >
                  {selectedProblem.title}
                </h2>

                {/* Description */}
                <p
                  style={{
                    color: "rgba(200,211,224,0.8)",
                    fontSize: "12px",
                    lineHeight: 1.7,
                    marginBottom: "16px",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {selectedProblem.description}
                </p>

                {/* Sections */}
                {[
                  { label: "Input Format", text: selectedProblem.input_format },
                  { label: "Output Format", text: selectedProblem.output_format },
                  { label: "Constraints", text: selectedProblem.constraints },
                ].map(({ label, text }) => (
                  <div key={label} style={{ marginBottom: "14px" }}>
                    <div
                      style={{
                        fontSize: "10px",
                        color: "#00ff88",
                        letterSpacing: "0.15em",
                        textTransform: "uppercase",
                        marginBottom: "4px",
                        fontFamily: "monospace",
                      }}
                    >
                      {label}
                    </div>
                    <p
                      style={{
                        color: "rgba(200,211,224,0.7)",
                        fontSize: "12px",
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {text}
                    </p>
                  </div>
                ))}

                {/* Example */}
                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      fontSize: "10px",
                      color: "#00ff88",
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                      marginBottom: "8px",
                      fontFamily: "monospace",
                    }}
                  >
                    Example
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {[
                      { label: "Input", value: selectedProblem.sample_input },
                      { label: "Output", value: selectedProblem.sample_output },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <div style={{ fontSize: "10px", color: "rgba(200,211,224,0.4)", marginBottom: "3px" }}>
                          {label}
                        </div>
                        <pre
                          style={{
                            background: "rgba(0,0,0,0.4)",
                            border: "1px solid rgba(0,255,136,0.1)",
                            borderRadius: "4px",
                            padding: "8px 10px",
                            fontSize: "12px",
                            color: "#c8d3e0",
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {value}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p style={{ color: "rgba(200,211,224,0.3)", fontSize: "12px", textAlign: "center", marginTop: "40px" }}>
                Select a problem
              </p>
            )
          ) : (
            /* Opponent Feed */
            <div>
              <div
                style={{
                  fontSize: "10px",
                  color: "rgba(200,211,224,0.4)",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  fontFamily: "monospace",
                  marginBottom: "12px",
                }}
              >
                OBFUSCATED FEED // read only
              </div>
              <pre
                style={{
                  fontSize: "12px",
                  color: "#c8d3e0",
                  background: "rgba(0,0,0,0.5)",
                  border: "1px solid rgba(200,211,224,0.08)",
                  borderRadius: "6px",
                  padding: "12px",
                  minHeight: "200px",
                  filter: "blur(6px)",
                  userSelect: "none",
                  pointerEvents: "none",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.6,
                }}
              >
                {opponentCode || "// opponent is thinking..."}
              </pre>
              <p
                style={{
                  fontSize: "10px",
                  color: "rgba(200,211,224,0.25)",
                  textAlign: "center",
                  marginTop: "10px",
                  fontFamily: "monospace",
                }}
              >
                feed is intentionally obfuscated
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ================================================================
          RIGHT PANEL — Game State
      ================================================================= */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: "rgba(10,12,16,0.95)",
          border: "1px solid rgba(0,255,136,0.15)",
          borderRadius: "8px",
          overflow: "hidden",
          padding: "14px",
          gap: "16px",
        }}
      >
        {/* Rendered by parent via props — this is the slot for the game panel */}
        {/* We forward these as a render-prop pattern via the GameStatePanel component */}
        <div style={{ color: "rgba(200,211,224,0.3)", fontSize: "11px", fontFamily: "monospace", textAlign: "center" }}>
          [Game state rendered by page.tsx]
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GC confirmation sub-component (exported for use in right panel)
// ---------------------------------------------------------------------------
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
  const insufficient = myHp < 80;
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
        <p style={{ color: "#ff4444", fontSize: "11px", marginBottom: "8px", fontFamily: "monospace" }}>
          This costs 80 HP. Confirm?
        </p>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            onClick={() => { setConfirming(false); onConfirm(); }}
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
          border: `1px solid ${disabled ? "rgba(200,211,224,0.15)" : "rgba(255,68,68,0.5)"}`,
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
      <p style={{ fontSize: "10px", color: "rgba(200,211,224,0.25)", marginTop: "4px", textAlign: "center", fontFamily: "monospace" }}>
        {gcUsed
          ? ""
          : insufficient
          ? "insufficient HP"
          : "costs 80 HP · blanks opponent 5s"}
      </p>
    </div>
  );
}
