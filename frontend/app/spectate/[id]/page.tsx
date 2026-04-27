"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { spectatorSocketUrl } from "../../../lib/ws";
import { api } from "../../../lib/api";

type BattleState = {
  id: number;
  status: string;
  player1: { id: number; display_name: string; username: string };
  player2: { id: number; display_name: string; username: string };
  player1_hp: number;
  player2_hp: number;
  current_round: number;
  spectator_likes: number;
};

type SampleRunPayload = {
  passed: boolean;
  output: string;
  expected: string;
  execution_time_ms: number;
  stderr?: string | null;
};

const EMOTES = ["🔥", "🤖", "💀", "⚔️", "🚀", "🐍"];

export default function SpectateBattlePage() {
  const params = useParams<{ id: string }>();
  const battleId = params.id;
  const { getToken } = useAuth();

  const [battle, setBattle] = useState<BattleState | null>(null);
  const [messageLog, setMessageLog] = useState<string[]>([]);
  /** Latest editor buffer per participant user id (from OPPONENT_CODE). */
  const [liveCodeByPlayerId, setLiveCodeByPlayerId] = useState<Record<number, string>>({});
  /** Last sample run (▷ Run) per player — from PLAYER_SAMPLE_RUN (server broadcast). */
  const [sampleRunByPlayerId, setSampleRunByPlayerId] = useState<
    Record<number, SampleRunPayload>
  >({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!battleId) return;
    api
      .get<BattleState>(`/api/battles/public/${battleId}/state/`)
      .then((res) => setBattle(res.data))
      .catch(() => setBattle(null));
  }, [battleId]);

  useEffect(() => {
    if (!battleId) return;

    let cancelled = false;
    let ws: WebSocket | null = null;

    const connect = async () => {
      const token = await getToken().catch(() => null);
      if (cancelled) return;
      ws = new WebSocket(spectatorSocketUrl(battleId, token ?? undefined));
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.event === "SPECTATOR_EMOTE") {
          setMessageLog((log) => [
            `[${msg.payload.username || "anon"}] ${msg.payload.emote}`,
            ...log.slice(0, 49),
          ]);
        }
        if (msg.event === "HP_UPDATE") {
          setBattle((b) =>
            b
              ? {
                  ...b,
                  player1_hp: msg.payload.player1_hp,
                  player2_hp: msg.payload.player2_hp,
                }
              : b
          );
        }
        if (msg.event === "SPECTATOR_LIKE_COUNT") {
          setBattle((b) =>
            b ? { ...b, spectator_likes: msg.payload.count ?? b.spectator_likes } : b
          );
        }
        if (msg.event === "OPPONENT_CODE") {
          const raw = msg.payload?.player_id;
          const code = typeof msg.payload?.code === "string" ? msg.payload.code : "";
          const pid =
            raw === null || raw === undefined || raw === ""
              ? null
              : Number(raw);
          if (pid != null && Number.isFinite(pid)) {
            setLiveCodeByPlayerId((prev) => ({ ...prev, [pid]: code }));
          }
        }
        if (msg.event === "PLAYER_SAMPLE_RUN") {
          const p = msg.payload ?? {};
          const raw = p.player_id;
          const pid =
            raw === null || raw === undefined || raw === ""
              ? null
              : Number(raw);
          if (pid != null && Number.isFinite(pid)) {
            setSampleRunByPlayerId((prev) => ({
              ...prev,
              [pid]: {
                passed: Boolean(p.passed),
                output: typeof p.output === "string" ? p.output : "",
                expected: typeof p.expected === "string" ? p.expected : "",
                execution_time_ms: Number(p.execution_time_ms) || 0,
                stderr: p.stderr ?? null,
              },
            }));
          }
        }
        if (msg.event === "ROUND_RESULT" || msg.event === "BATTLE_END") {
          api
            .get<BattleState>(`/api/battles/public/${battleId}/state/`)
            .then((res) => setBattle(res.data))
            .catch(() => {});
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (ws) {
        ws.close();
      }
      wsRef.current = null;
    };
  }, [battleId, getToken]);

  const sendLike = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: "SPECTATOR_LIKE", payload: {} }));
  };

  const sendEmote = (emote: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        event: "SPECTATOR_EMOTE",
        payload: { emote, username: "spectator" },
      })
    );
  };

  if (!battle) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0a0c10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(200,211,224,0.6)",
          fontSize: "14px",
        }}
      >
        Tuning into arena feed…
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0c10",
        color: "#c8d3e0",
        padding: "16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <Link
          href="/spectate"
          style={{
            color: "#00ff88",
            fontSize: "12px",
            fontFamily: "monospace",
            textDecoration: "none",
            borderBottom: "1px solid rgba(0,255,136,0.35)",
          }}
        >
          ← Lobby
        </Link>
        <span style={{ color: "rgba(200,211,224,0.4)", fontSize: "11px" }}>
          ♥ {battle.spectator_likes} likes
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <section
          style={{
            flex: "1 1 320px",
            border: "1px solid rgba(0,255,136,0.15)",
            borderRadius: "8px",
            padding: "16px",
            background: "rgba(8,10,14,0.95)",
          }}
        >
          <header style={{ marginBottom: "12px" }}>
            <div
              style={{
                color: "#00ff88",
                fontSize: "11px",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              Live // Battle #{battle.id}
            </div>
            <div style={{ fontSize: "11px", color: "rgba(200,211,224,0.45)", marginTop: "4px" }}>
              {battle.status} · Round {battle.current_round}
            </div>
          </header>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ minWidth: "100px" }}>{battle.player1.display_name}</span>
              <div
                style={{
                  flex: 1,
                  height: "8px",
                  background: "rgba(0,0,0,0.4)",
                  borderRadius: "4px",
                  overflow: "hidden",
                  maxWidth: "200px",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${battle.player1_hp}%`,
                    background: "linear-gradient(90deg, #00ff88, #00aa55)",
                  }}
                />
              </div>
              <span style={{ color: "rgba(200,211,224,0.6)" }}>{battle.player1_hp}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ minWidth: "100px" }}>{battle.player2.display_name}</span>
              <div
                style={{
                  flex: 1,
                  height: "8px",
                  background: "rgba(0,0,0,0.4)",
                  borderRadius: "4px",
                  overflow: "hidden",
                  maxWidth: "200px",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${battle.player2_hp}%`,
                    background: "linear-gradient(90deg, #ff8844, #ff4444)",
                  }}
                />
              </div>
              <span style={{ color: "rgba(200,211,224,0.6)" }}>{battle.player2_hp}</span>
            </div>
          </div>

          <div
            style={{
              marginTop: "16px",
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: "12px",
              minHeight: "min(52vh, 480px)",
            }}
          >
            {[battle.player1, battle.player2].map((p) => {
              const uid = Number(p.id);
              const hasLive =
                Number.isFinite(uid) &&
                Object.prototype.hasOwnProperty.call(liveCodeByPlayerId, uid);
              const cell = hasLive ? liveCodeByPlayerId[uid] : undefined;
              const run = Number.isFinite(uid) ? sampleRunByPlayerId[uid] : undefined;
              return (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  border: "1px solid rgba(0,255,136,0.12)",
                  borderRadius: "6px",
                  overflow: "hidden",
                  background: "rgba(0,0,0,0.35)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    fontSize: "10px",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "rgba(0,255,136,0.75)",
                    borderBottom: "1px solid rgba(0,255,136,0.1)",
                    fontFamily: "monospace",
                  }}
                >
                  Live code · {p.display_name}
                </div>
                <pre
                  style={{
                    flex: 1,
                    margin: 0,
                    padding: "10px",
                    overflow: "auto",
                    fontSize: "11px",
                    lineHeight: 1.45,
                    color: "rgba(200,211,224,0.92)",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minHeight: "120px",
                  }}
                >
                  {hasLive ? String(cell ?? "") : "Waiting for editor activity…"}
                </pre>
                <div
                  style={{
                    borderTop: "1px solid rgba(0,255,136,0.12)",
                    padding: "8px 10px",
                    background: "rgba(0,0,0,0.55)",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: "10px",
                    lineHeight: 1.5,
                    color: "rgba(180,195,210,0.95)",
                    maxHeight: "min(28vh, 220px)",
                    overflow: "auto",
                  }}
                >
                  <div
                    style={{
                      color: "rgba(0,255,136,0.65)",
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      marginBottom: "6px",
                      fontSize: "9px",
                    }}
                  >
                    Sample run output
                  </div>
                  {run ? (
                    <>
                      <div style={{ color: run.passed ? "#00ff88" : "#ff6666" }}>
                        {run.passed ? "PASS" : "FAIL"} · {run.execution_time_ms}ms
                      </div>
                      <div style={{ color: "rgba(200,211,224,0.55)", marginTop: "4px" }}>
                        stdout:
                      </div>
                      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {run.output || "(empty)"}
                      </div>
                      {!run.passed && (
                        <>
                          <div style={{ color: "rgba(200,211,224,0.45)", marginTop: "6px" }}>
                            expected:
                          </div>
                          <div style={{ color: "#99ff99", whiteSpace: "pre-wrap" }}>
                            {run.expected}
                          </div>
                        </>
                      )}
                      {run.stderr ? (
                        <>
                          <div style={{ color: "rgba(255,170,100,0.85)", marginTop: "6px" }}>
                            stderr:
                          </div>
                          <div style={{ color: "#ffaa88", whiteSpace: "pre-wrap" }}>
                            {run.stderr}
                          </div>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span style={{ color: "rgba(200,211,224,0.35)" }}>
                      Waiting for ▷ Run (sample)…
                    </span>
                  )}
                </div>
              </div>
            );
            })}
          </div>
        </section>

        <aside
          style={{
            width: "100%",
            maxWidth: "320px",
            border: "1px solid rgba(0,255,136,0.15)",
            borderRadius: "8px",
            padding: "16px",
            background: "rgba(8,10,14,0.95)",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <h2
            style={{
              fontSize: "11px",
              letterSpacing: "0.2em",
              color: "#00ff88",
              margin: 0,
              textTransform: "uppercase",
            }}
          >
            Interact
          </h2>
          <button
            type="button"
            onClick={sendLike}
            style={{
              padding: "10px 16px",
              borderRadius: "6px",
              border: "1px solid rgba(255,100,150,0.5)",
              background: "rgba(255,100,150,0.08)",
              color: "#ff88aa",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: "12px",
            }}
          >
            ♥ Like ({battle.spectator_likes})
          </button>
          <div style={{ fontSize: "11px", color: "rgba(200,211,224,0.45)" }}>Emotes</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {EMOTES.map((emote) => (
              <button
                key={emote}
                type="button"
                onClick={() => sendEmote(emote)}
                style={{
                  width: "40px",
                  height: "40px",
                  fontSize: "18px",
                  borderRadius: "6px",
                  border: "1px solid rgba(0,255,136,0.2)",
                  background: "rgba(0,0,0,0.4)",
                  cursor: "pointer",
                }}
              >
                {emote}
              </button>
            ))}
          </div>
          <div style={{ fontSize: "11px", color: "rgba(200,211,224,0.45)" }}>Feed</div>
          <div style={{ maxHeight: "min(40vh, 200px)", overflowY: "auto", fontSize: "11px" }}>
            {messageLog.map((msg, idx) => (
              <div key={idx} style={{ marginBottom: "4px" }}>
                {msg}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
