"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth, useUser } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../../lib/fetchWithAuth";
import { battleSocketUrl } from "../../../lib/ws";
import { GCButton } from "../../../components/BattleEditors";

const MonacoEditorInner = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: "11px", color: "rgba(200,211,224,0.4)" }}>
      Loading editor…
    </div>
  ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type DjangoUser = {
  id: number;
  username: string;
  display_name: string;
  role: string;
};

type BattlePlayer = { id: number; username: string; display_name: string };

type ProblemInfo = {
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

type RoundInfo = {
  id: number;
  round_number: number;
  problem: ProblemInfo;
};

type BattleState = {
  id: number;
  player1: BattlePlayer;
  player2: BattlePlayer;
  player1_hp: number;
  player2_hp: number;
  current_round: number;
  status: string;
  /** Wall-clock end of match (server). */
  ends_at?: string | null;
  /** Set when battle is completed (winner user id). */
  winner?: number | null;
  rounds?: RoundInfo[];
  /** Present on resign response / share payload. */
  share_url?: string;
};

type WSMessage = {
  event: string;
  payload: Record<string, any>;
};

type Toast = {
  id: number;
  message: string;
  type: "info" | "success" | "danger" | "warning";
};

type RunResult = {
  passed: boolean;
  output: string;
  expected: string;
  execution_time_ms: number;
  stderr?: string | null;
};

// ---------------------------------------------------------------------------
// HP bar helpers
// ---------------------------------------------------------------------------
const hpColor = (hp: number) => {
  if (hp > 60) return "#00cc66";
  if (hp > 30) return "#ffa500";
  return "#ff4444";
};

const HpBar = ({
  name,
  hp,
  isMe,
}: {
  name: string;
  hp: number;
  isMe: boolean;
}) => {
  const clamped = Math.max(0, hp);
  const color = hpColor(clamped);
  const pulse = clamped < 30;

  return (
    <div style={{ marginBottom: "10px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "4px",
          fontSize: "11px",
          fontFamily: "monospace",
        }}
      >
        <span style={{ color: isMe ? "#00ff88" : "rgba(200,211,224,0.7)" }}>
          {isMe ? "▶ " : ""}
          {name}
        </span>
        <span
          style={{
            color,
            fontWeight: "bold",
            animation: pulse ? "pulse 1s infinite" : "none",
          }}
        >
          {clamped}
        </span>
      </div>
      <div
        style={{
          height: "6px",
          background: "rgba(200,211,224,0.08)",
          borderRadius: "3px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${clamped}%`,
            background: color,
            borderRadius: "3px",
            transition: "width 300ms ease, background 300ms ease",
            boxShadow: pulse ? `0 0 8px ${color}` : "none",
          }}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function BattlePage() {
  const params = useParams<{ id: string }>();
  const battleId = params.id;
  const router = useRouter();
  const { isSignedIn } = useUser();
  const { getToken } = useAuth();
  const api = useApiClient();
  const fetchMe = useFetchMe();

  // Core state
  const [djangoUser, setDjangoUser] = useState<DjangoUser | null>(null);
  const [battle, setBattle] = useState<BattleState | null>(null);
  const [myCode, setMyCode] = useState("");
  const [opponentCode, setOpponentCode] = useState("");
  const [timer, setTimer] = useState(30 * 60);
  const [selectedLanguage, setSelectedLanguage] = useState("python");
  const [selectedProblemIdx, setSelectedProblemIdx] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResigning, setIsResigning] = useState(false);

  // Solved problems tracking (by problem id)
  const [solvedProblems, setSolvedProblems] = useState<Set<number>>(new Set());
  /** Local submit lock — server rejects duplicate submits; WS may be down so ROUND_RESULT never marks solved. */
  const [submittedProblems, setSubmittedProblems] = useState<Set<number>>(new Set());

  // Round result flash
  const [roundFlash, setRoundFlash] = useState<{
    type: "win" | "lose" | "fail";
    message: string;
  } | null>(null);

  // Sabotage state
  const [gcUsed, setGcUsed] = useState(false);
  const [gcActive, setGcActive] = useState(false);
  const [fogActive, setFogActive] = useState(false);

  // Toast notifications
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  // WS ref
  const wsRef = useRef<WebSocket | null>(null);

  // Refs to avoid stale closures
  const battleRef = useRef(battle);
  const djangoUserRef = useRef(djangoUser);
  useEffect(() => { battleRef.current = battle; }, [battle]);
  useEffect(() => { djangoUserRef.current = djangoUser; }, [djangoUser]);

  const battleComplete = battle?.status === "completed";

  // ------------------------------------------------------------------
  // Toast helper
  // ------------------------------------------------------------------
  const addToast = useCallback(
    (message: string, type: Toast["type"] = "info") => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev.slice(-4), { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    []
  );

  // ------------------------------------------------------------------
  // Fetch Django user
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!isSignedIn) return;
    fetchMe()
      .then((u: DjangoUser) => setDjangoUser(u))
      .catch(() => {});
  }, [isSignedIn, fetchMe]);

  // ------------------------------------------------------------------
  // Fetch battle state
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!battleId) return;
    api
      .get(`/api/battles/${battleId}/state/`)
      .then((res) => setBattle(res.data));
  }, [battleId, api]);

  /** Sync countdown to server end time. */
  useEffect(() => {
    if (!battle) return;
    if (battle.status === "completed") return;
    if (battle.ends_at) {
      const sec = Math.max(
        0,
        Math.floor((new Date(battle.ends_at).getTime() - Date.now()) / 1000)
      );
      setTimer(sec);
    }
  }, [battle?.id, battle?.ends_at, battle?.status]);

  /** Completed battle → report card page. */
  useEffect(() => {
    if (!battleId || !battle || battle.status !== "completed") return;
    router.replace(`/battle/${battleId}/ended`);
  }, [battleId, battle, router]);

  const timeUpPollRef = useRef(false);
  useEffect(() => {
    if (timer > 0) timeUpPollRef.current = false;
  }, [timer]);

  /** Timer hit 0 — server finalizes on next GET (works without Celery). */
  useEffect(() => {
    if (!battleId || !battle || battleComplete) return;
    if (timer > 0 || battle.status === "completed") return;
    if (timeUpPollRef.current) return;
    timeUpPollRef.current = true;
    let cancelled = false;
    api.get(`/api/battles/${battleId}/state/`).then((res) => {
      if (cancelled) return;
      const b = res.data as BattleState;
      setBattle(b);
      if (b.status === "completed") {
        router.replace(`/battle/${battleId}/ended`);
      } else if (b.ends_at) {
        const sec = Math.max(
          0,
          Math.floor((new Date(b.ends_at).getTime() - Date.now()) / 1000)
        );
        setTimer(sec);
        timeUpPollRef.current = false;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [timer, battleComplete, battleId, battle, api, router]);

  // ------------------------------------------------------------------
  // Editor change — broadcast every keystroke so spectators see live typing
  // ------------------------------------------------------------------
  const handleCodeChange = useCallback((code: string) => {
    setMyCode(code);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "code_update", code }));
    }
  }, []);

  // ------------------------------------------------------------------
  // WebSocket — single connection (Clerk token → Django user on WS for code_update player_id)
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!battleId || !isSignedIn) return;

    let cancelled = false;
    let ws: WebSocket | null = null;

    const connect = async () => {
      const token = await getToken();
      if (!token || cancelled) return;

      ws = new WebSocket(battleSocketUrl(battleId, token));
      wsRef.current = ws;

      ws.onopen = () => {
        const ping = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: "PING", payload: {} }));
          }
        }, 25_000);
        (ws as any).__pingInterval = ping;
      };

      ws.onmessage = (event) => {
      const msg: WSMessage = JSON.parse(event.data);
      const p = msg.payload;
      const b = battleRef.current;
      const me = djangoUserRef.current;

      switch (msg.event) {
        // HP update — animate bars
        case "HP_UPDATE":
          if (b) {
            setBattle({
              ...b,
              player1_hp: p.player1_hp,
              player2_hp: p.player2_hp,
            });
          }
          break;

        // Submission lifecycle
        case "SUBMISSION_RECEIVED":
          if (me && p.player_id !== me.id) {
            addToast("Opponent is submitting…", "warning");
          }
          break;

        case "SUBMISSION_FAILED":
          if (me && p.player_id === me.id) {
            addToast(`Failed: ${p.passed}/${p.total} test cases passed`, "danger");
            setRoundFlash({
              type: "fail",
              message: `${p.passed}/${p.total} test cases passed`,
            });
          } else {
            addToast("Opponent submitted — failed ✗", "info");
          }
          break;

        case "SUBMISSION_PASSED":
          if (me && p.player_id === me.id) {
            addToast("All tests passed! ✓", "success");
          }
          break;

        // Round result — flash panel
        case "ROUND_RESULT": {
          const isWin = me && p.winner_id === me.id;
          if (isWin) {
            const hpChange = Math.abs(p.hp_change ?? 35);
            addToast(`Round won — opponent −${hpChange} HP 🔥`, "success");
            setRoundFlash({
              type: "win",
              message: `Round won — opponent −${hpChange} HP`,
            });
            // Mark problem as solved
            if (p.problem_id) {
              setSolvedProblems((prev) => new Set([...prev, p.problem_id]));
            }
          } else {
            addToast(
              `Opponent was faster. You lost ${Math.abs(p.hp_change ?? 35)} HP`,
              "danger"
            );
            setRoundFlash({
              type: "lose",
              message: "Opponent was faster",
            });
          }
          setTimeout(() => setRoundFlash(null), 3000);
          break;
        }

        // Efficiency result
        case "EFFICIENCY_RESULT":
          if (me && p.winner_id === me.id) {
            addToast(
              `Efficiency bonus! ${p.winner_complexity} vs ${p.loser_complexity}. −10 HP ⚡`,
              "success"
            );
          } else if (me) {
            addToast(
              `Opponent more efficient (${p.winner_complexity}). −10 HP`,
              "danger"
            );
          }
          break;

        // GC
        case "GC_START":
          if (me && p.target_user_id === me.id) {
            setGcActive(true);
            addToast("⚠ GARBAGE COLLECTION — IDE blanked for 5s", "danger");
          } else {
            addToast("You activated Garbage Collection on opponent!", "success");
          }
          break;
        case "GC_END":
          if (me && p.target_user_id === me.id) {
            setGcActive(false);
          }
          break;

        // Fog
        case "FOG_START":
          setFogActive(true);
          addToast("☁ FOG OF WAR — visibility reduced", "warning");
          break;
        case "FOG_END":
          setFogActive(false);
          break;

        // Battle end → report card route (both players)
        case "BATTLE_END":
          if (b) {
            setBattle({
              ...b,
              status: "completed",
              winner: p.winner_id ?? b.winner ?? null,
              player1_hp: p.player1_final_hp ?? b.player1_hp,
              player2_hp: p.player2_final_hp ?? b.player2_hp,
            });
          }
          router.replace(`/battle/${battleId}/ended`);
          break;

        // Opponent code feed (ignore until server sends real player_id — needs WS ?token=)
        case "OPPONENT_CODE":
          if (
            me &&
            p.player_id != null &&
            p.player_id !== me.id
          ) {
            setOpponentCode(p.code ?? "");
          }
          break;

        case "PONG":
          break;

        default:
          break;
      }
    };

      ws.onclose = () => {
        clearInterval((ws as any).__pingInterval);
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (ws) {
        clearInterval((ws as any).__pingInterval);
        ws.close();
      }
      wsRef.current = null;
    };
  }, [battleId, addToast, isSignedIn, getToken, router]);

  // ------------------------------------------------------------------
  // Timer countdown
  // ------------------------------------------------------------------
  useEffect(() => {
    if (battleComplete) return;
    const interval = window.setInterval(() => {
      setTimer((t) => Math.max(0, t - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [battleComplete]);

  // ------------------------------------------------------------------
  // Run — synchronous sample execution
  // ------------------------------------------------------------------
  const handleRun = useCallback(
    async (
      code: string,
      lang: string,
      problemId: number
    ): Promise<RunResult | null> => {
      try {
        const res = await api.post(`/api/battles/${battleId}/run/`, {
          problem_id: problemId,
          code,
          language: lang,
        });
        return res.data as RunResult;
      } catch (err: any) {
        const detail = err?.response?.data?.detail ?? "Run failed";
        addToast(detail, "danger");
        return null;
      }
    },
    [battleId, api, addToast]
  );

  // ------------------------------------------------------------------
  // Submit — fires Celery task server-side
  // ------------------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    if (!battle || isSubmitting) return;
    const problems = battle.rounds ?? [];
    const round = problems[selectedProblemIdx];
    if (!round) {
      addToast("No problem selected", "danger");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await api.post(`/api/battles/${battleId}/submit/`, {
        code: myCode,
        language: selectedLanguage,
        problem_id: round.problem.id,
      });
      setSubmittedProblems((prev) => new Set([...prev, round.problem.id]));
      const evaluation = res.data?.evaluation;
      if (evaluation) {
        try {
          sessionStorage.setItem(
            `arena-eval-${battleId}-${round.problem.id}`,
            JSON.stringify(evaluation)
          );
        } catch {
          /* ignore quota */
        }
      }
      addToast("Code evaluated — opening review.", "success");
      router.push(`/battle/${battleId}/review/${round.problem.id}`);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? "Submission error";
      const msg = typeof detail === "string" ? detail : "";
      if (msg.toLowerCase().includes("already submitted")) {
        setSubmittedProblems((prev) => new Set([...prev, round.problem.id]));
        addToast("Already submitted — waiting for result.", "info");
        router.push(`/battle/${battleId}/review/${round.problem.id}`);
      } else {
        addToast(detail, "danger");
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [
    battle,
    battleId,
    myCode,
    selectedLanguage,
    selectedProblemIdx,
    api,
    isSubmitting,
    addToast,
    router,
  ]);

  // ------------------------------------------------------------------
  // Resign — forfeit (opponent wins, battle ends)
  // ------------------------------------------------------------------
  const handleResign = useCallback(async () => {
    if (!battleId || battleComplete || !djangoUser) return;
    if (
      !window.confirm(
        "Resign and end the battle? Your opponent wins and ratings will be updated."
      )
    ) {
      return;
    }
    setIsResigning(true);
    try {
      const res = await api.post(`/api/battles/${battleId}/resign/`);
      const b = res.data as BattleState;
      setBattle(b);
      addToast("You resigned — battle ended.", "warning");
      router.replace(`/battle/${battleId}/ended`);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? "Could not resign";
      addToast(typeof detail === "string" ? detail : "Could not resign", "danger");
    } finally {
      setIsResigning(false);
    }
  }, [battleId, battleComplete, djangoUser, api, addToast, router]);

  // ------------------------------------------------------------------
  // Trigger GC sabotage
  // ------------------------------------------------------------------
  const triggerGC = useCallback(async () => {
    if (gcUsed || !battle) return;
    try {
      await api.post(`/api/battles/${battleId}/sabotage/`, {
        move_type: "GARBAGE_COLLECTION",
      });
      setGcUsed(true);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? "Sabotage failed";
      addToast(detail, "danger");
    }
  }, [gcUsed, battle, battleId, api, addToast]);

  // ------------------------------------------------------------------
  // Derived values
  // ------------------------------------------------------------------
  const meIsPlayer1 = useMemo(() => {
    if (!battle || !djangoUser) return true;
    return battle.player1.id === djangoUser.id;
  }, [battle, djangoUser]);

  const minutes = Math.floor(timer / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (timer % 60).toString().padStart(2, "0");
  const timerCritical = timer < 300; // < 5 minutes

  // ------------------------------------------------------------------
  // Loading state
  // ------------------------------------------------------------------
  if (!djangoUser || !battle) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "#0a0c10",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: "24px",
              marginBottom: "12px",
              animation: "spin 2s linear infinite",
            }}
          >
            ⟳
          </div>
          <p
            style={{
              color: "rgba(200,211,224,0.5)",
              fontSize: "12px",
              fontFamily: "monospace",
              letterSpacing: "0.1em",
            }}
          >
            Spinning up battle instance…
          </p>
        </div>
      </div>
    );
  }

  const myHp = meIsPlayer1 ? battle.player1_hp : battle.player2_hp;
  const oppHp = meIsPlayer1 ? battle.player2_hp : battle.player1_hp;
  const myName = meIsPlayer1
    ? battle.player1.display_name
    : battle.player2.display_name;
  const oppName = meIsPlayer1
    ? battle.player2.display_name
    : battle.player1.display_name;
  const problems = (battle.rounds ?? []).map((r) => r.problem);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#0a0c10",
        padding: "8px",
        gap: "8px",
        boxSizing: "border-box",
        fontFamily: "monospace",
      }}
    >
      {/* ============ GLOBAL STYLES ============ */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes flash-green { 0%,100% { background: rgba(10,12,16,0.95); } 50% { background: rgba(0,255,136,0.12); } }
        @keyframes flash-red { 0%,100% { background: rgba(10,12,16,0.95); } 50% { background: rgba(255,68,68,0.12); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,255,136,0.2); border-radius: 2px; }
      `}</style>

      {/* ============ TOAST NOTIFICATIONS ============ */}
      <div
        style={{
          position: "fixed",
          top: "12px",
          right: "12px",
          zIndex: 100,
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: "8px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              fontFamily: "monospace",
              maxWidth: "320px",
              background:
                t.type === "success"
                  ? "rgba(0,255,136,0.12)"
                  : t.type === "danger"
                  ? "rgba(255,68,68,0.12)"
                  : t.type === "warning"
                  ? "rgba(255,165,0,0.12)"
                  : "rgba(200,211,224,0.08)",
              border: `1px solid ${
                t.type === "success"
                  ? "rgba(0,255,136,0.3)"
                  : t.type === "danger"
                  ? "rgba(255,68,68,0.3)"
                  : t.type === "warning"
                  ? "rgba(255,165,0,0.3)"
                  : "rgba(200,211,224,0.15)"
              }`,
              color:
                t.type === "success"
                  ? "#00ff88"
                  : t.type === "danger"
                  ? "#ff6666"
                  : t.type === "warning"
                  ? "#ffa500"
                  : "#c8d3e0",
              animation: "fadeIn 0.2s ease",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* ============ THIN TOP BAR ============ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 4px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: "#00ff88",
            fontSize: "11px",
            letterSpacing: "0.25em",
            textTransform: "uppercase",
          }}
        >
          Battle #{battle.id}
        </span>
        {battleComplete && (
          <span
            style={{
              color: "#ff4444",
              fontSize: "11px",
              letterSpacing: "0.2em",
              animation: "pulse 1s infinite",
            }}
          >
            BATTLE OVER
          </span>
        )}
        <span style={{ color: "rgba(200,211,224,0.3)", fontSize: "10px" }}>
          {problems.length} problems
        </span>
      </div>

      {/* ============ 3-PANEL GRID ============ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "40% 35% 25%",
          gridTemplateRows: "minmax(0, 1fr)",
          flex: 1,
          gap: "8px",
          minHeight: 0,
          alignItems: "stretch",
        }}
      >
        {/* ---- LEFT: Code Editor ---- */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "rgba(10,12,16,0.95)",
            border: "1px solid rgba(0,255,136,0.15)",
            borderRadius: "8px",
            overflow: "hidden",
            minHeight: 0,
            height: "100%",
            ...(roundFlash
              ? {
                  animation: `${
                    roundFlash.type === "win" ? "flash-green" : "flash-red"
                  } 600ms ease`,
                }
              : {}),
          }}
        >
          {/* Editor header */}
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
            <span
              style={{
                color: "#00ff88",
                fontSize: "11px",
                letterSpacing: "0.2em",
                fontFamily: "monospace",
              }}
            >
              your editor // arena
            </span>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
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

          {/* Monaco editor area */}
          <EditorPane
            myCode={myCode}
            onChangeMyCode={handleCodeChange}
            language={selectedLanguage}
            gcActive={gcActive}
            fogActive={fogActive}
            selectedProblem={problems[selectedProblemIdx] ?? null}
            battleId={battleId}
            selectedProblemIdx={selectedProblemIdx}
            solvedProblems={solvedProblems}
            submittedProblems={submittedProblems}
            isSubmitting={isSubmitting}
            battleComplete={battleComplete}
            onRun={handleRun}
            onSubmit={handleSubmit}
          />
        </div>

        {/* ---- MIDDLE: Problem/Opponent ---- */}
        <MiddlePanel
          problems={problems}
          selectedProblemIdx={selectedProblemIdx}
          onSelectProblem={setSelectedProblemIdx}
          solvedProblems={solvedProblems}
          opponentCode={opponentCode}
        />

        {/* ---- RIGHT: Game State ---- */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "rgba(10,12,16,0.95)",
            border: "1px solid rgba(0,255,136,0.15)",
            borderRadius: "8px",
            minHeight: 0,
            height: "100%",
            padding: "14px",
            gap: "16px",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {/* Battle ID header */}
          <div
            style={{
              color: "#00ff88",
              fontSize: "12px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              paddingBottom: "10px",
              borderBottom: "1px solid rgba(0,255,136,0.1)",
            }}
          >
            Battle #{battle.id}
          </div>

          {/* HP SECTION */}
          <div>
            <div
              style={{
                fontSize: "9px",
                color: "rgba(200,211,224,0.3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                marginBottom: "10px",
              }}
            >
              HP
            </div>
            <HpBar name={myName} hp={myHp} isMe />
            <HpBar name={oppName} hp={oppHp} isMe={false} />
          </div>

          {/* TIMER */}
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: "9px",
                color: "rgba(200,211,224,0.3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                marginBottom: "6px",
              }}
            >
              TIME REMAINING
            </div>
            <div
              style={{
                fontSize: "28px",
                fontWeight: "700",
                fontFamily: "monospace",
                color: timerCritical ? "#ff4444" : "#c8d3e0",
                letterSpacing: "0.05em",
                animation: timerCritical ? "pulse 1s infinite" : "none",
              }}
            >
              {minutes}:{seconds}
            </div>
          </div>

          {/* PROBLEMS LIST */}
          <div>
            <div
              style={{
                fontSize: "9px",
                color: "rgba(200,211,224,0.3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                marginBottom: "8px",
              }}
            >
              Problems
            </div>
            {(battle.rounds ?? []).map((r, idx) => {
              const isSolved = solvedProblems.has(r.problem.id);
              const isActive = idx === selectedProblemIdx;
              const diffC =
                r.problem.difficulty === "easy"
                  ? "#00cc66"
                  : r.problem.difficulty === "medium"
                  ? "#ffa500"
                  : "#ff4444";
              return (
                <button
                  key={r.id}
                  onClick={() => setSelectedProblemIdx(idx)}
                  style={{
                    width: "100%",
                    background: isActive
                      ? "rgba(0,191,255,0.05)"
                      : "transparent",
                    border: "none",
                    borderLeft: isActive
                      ? "3px solid #00bfff"
                      : "3px solid transparent",
                    padding: "7px 8px",
                    marginBottom: "2px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    borderRadius: "0 4px 4px 0",
                    transition: "background 0.15s",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      fontSize: "9px",
                      fontWeight: "600",
                      color: diffC,
                      border: `1px solid ${diffC}`,
                      borderRadius: "3px",
                      padding: "1px 5px",
                      letterSpacing: "0.05em",
                      flexShrink: 0,
                      fontFamily: "monospace",
                    }}
                  >
                    {r.problem.difficulty.slice(0, 4).toUpperCase()}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      color: isSolved
                        ? "rgba(200,211,224,0.4)"
                        : "#c8d3e0",
                      textDecoration: isSolved ? "line-through" : "none",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.problem.title}
                  </span>
                  <span style={{ flexShrink: 0 }}>
                    {isSolved ? (
                      <span style={{ color: "#00cc66", fontSize: "12px" }}>●</span>
                    ) : (
                      <span
                        style={{
                          color: "rgba(200,211,224,0.25)",
                          fontSize: "12px",
                        }}
                      >
                        ○
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* SABOTAGE — GC */}
          <div>
            <div
              style={{
                fontSize: "9px",
                color: "rgba(200,211,224,0.3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                marginBottom: "8px",
              }}
            >
              Sabotage
            </div>
            <GCButton
              gcUsed={gcUsed}
              myHp={myHp}
              battleComplete={battleComplete}
              onConfirm={triggerGC}
            />
          </div>

          {/* Resign */}
          <div>
            <div
              style={{
                fontSize: "9px",
                color: "rgba(200,211,224,0.3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                marginBottom: "8px",
              }}
            >
              End battle
            </div>
            <button
              type="button"
              onClick={() => void handleResign()}
              disabled={battleComplete || isResigning}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "6px",
                border: "1px solid rgba(255,100,100,0.45)",
                background: "rgba(255,60,60,0.06)",
                color: "#ff8888",
                fontSize: "11px",
                fontFamily: "monospace",
                letterSpacing: "0.12em",
                cursor: battleComplete || isResigning ? "not-allowed" : "pointer",
                opacity: battleComplete || isResigning ? 0.45 : 1,
              }}
            >
              {isResigning ? "Resigning…" : "Resign (forfeit)"}
            </button>
            <div
              style={{
                marginTop: "6px",
                fontSize: "9px",
                color: "rgba(200,211,224,0.28)",
                lineHeight: 1.4,
              }}
            >
              Ends the match now. Opponent wins; ELO updates apply.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditorPane — left panel editor + run/submit actions
// ---------------------------------------------------------------------------

type RunResult2 = {
  passed: boolean;
  output: string;
  expected: string;
  execution_time_ms: number;
  stderr?: string | null;
};

function EditorPane({
  myCode,
  onChangeMyCode,
  language,
  gcActive,
  fogActive,
  selectedProblem,
  battleId,
  selectedProblemIdx,
  solvedProblems,
  submittedProblems,
  isSubmitting,
  battleComplete,
  onRun,
  onSubmit,
}: {
  myCode: string;
  onChangeMyCode: (c: string) => void;
  language: string;
  gcActive: boolean;
  fogActive: boolean;
  selectedProblem: ProblemInfo | null;
  battleId: string;
  selectedProblemIdx: number;
  solvedProblems: Set<number>;
  submittedProblems: Set<number>;
  isSubmitting: boolean;
  battleComplete: boolean;
  onRun: (code: string, lang: string, pid: number) => Promise<RunResult2 | null>;
  onSubmit: () => void;
}) {
  const monacoLanguage =
    language === "cpp" ? "cpp" : language === "javascript" ? "javascript" : "python";

  const [isRunning, setIsRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult2 | null>(null);
  const [runCooldown, setRunCooldown] = useState(false);

  useEffect(() => {
    setRunResult(null);
    setRunCooldown(false);
  }, [selectedProblemIdx]);

  const handleRun = async () => {
    if (!selectedProblem || isRunning || runCooldown) return;
    setIsRunning(true);
    setRunResult(null);
    try {
      const r = await onRun(myCode, language, selectedProblem.id);
      if (r) setRunResult(r);
    } finally {
      setIsRunning(false);
      setRunCooldown(true);
      setTimeout(() => setRunCooldown(false), 3000);
    }
  };

  const isSolved = solvedProblems.has(selectedProblem?.id ?? -1);
  const hasSubmitted = submittedProblems.has(selectedProblem?.id ?? -1);

  const actionBar = (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid rgba(0,255,136,0.15)",
        display: "flex",
        gap: "8px",
        alignItems: "center",
        flexShrink: 0,
        background: "rgba(8,10,14,0.98)",
        zIndex: 25,
      }}
    >
      <button
        id="run-btn"
        type="button"
        onClick={handleRun}
        disabled={isRunning || runCooldown || !selectedProblem}
        style={{
          background: "rgba(0,255,136,0.08)",
          border: "1px solid rgba(0,255,136,0.35)",
          borderRadius: "4px",
          color:
            isRunning || runCooldown
              ? "rgba(200,211,224,0.25)"
              : "#00ff88",
          fontSize: "12px",
          padding: "6px 16px",
          cursor: isRunning || runCooldown ? "not-allowed" : "pointer",
          fontFamily: "monospace",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {isRunning ? "Running…" : runCooldown ? "wait…" : "▷ Run (sample)"}
      </button>
      <button
        id="submit-btn"
        type="button"
        onClick={onSubmit}
        disabled={
          isSubmitting ||
          battleComplete ||
          isSolved ||
          hasSubmitted ||
          !selectedProblem
        }
        style={{
          background:
            isSubmitting || battleComplete || isSolved || hasSubmitted
              ? "transparent"
              : "rgba(0,255,136,0.12)",
          border: `1px solid ${
            isSubmitting || battleComplete || isSolved || hasSubmitted
              ? "rgba(200,211,224,0.15)"
              : "#00ff88"
          }`,
          borderRadius: "4px",
          color:
            isSubmitting || battleComplete || isSolved || hasSubmitted
              ? "rgba(200,211,224,0.25)"
              : "#00ff88",
          fontSize: "12px",
          padding: "6px 16px",
          cursor:
            isSubmitting || battleComplete || isSolved || hasSubmitted
              ? "not-allowed"
              : "pointer",
          fontFamily: "monospace",
          letterSpacing: "0.06em",
          fontWeight: 700,
          flex: 1,
        }}
      >
        {isSubmitting
          ? "Submitting…"
          : isSolved
            ? "✓ Solved"
            : hasSubmitted
              ? "Submitted"
              : "Submit"}
      </button>
      <span
        style={{
          fontSize: "9px",
          color: "rgba(200,211,224,0.35)",
          maxWidth: "120px",
          lineHeight: 1.3,
        }}
        title="Run tests on the sample only. Submit runs all hidden tests."
      >
        Run = sample · Submit = judge
      </span>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {actionBar}
      {/* Monaco editor */}
      <div
        style={{
          flex: 1,
          position: "relative",
          overflowY: "auto",
          overflowX: "hidden",
          minHeight: 0,
        }}
      >
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
            <span style={{ fontSize: "32px", animation: "pulse 1s infinite" }}>☠</span>
            <span
              style={{
                color: "#ff4444",
                fontSize: "13px",
                fontWeight: "bold",
                letterSpacing: "0.1em",
              }}
            >
              GARBAGE COLLECTION
            </span>
            <span style={{ color: "rgba(200,211,224,0.4)", fontSize: "11px" }}>
              IDE blanked — your buffer is safe
            </span>
          </div>
        )}
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
        <MonacoEditorInner
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
            readOnly: battleComplete,
          }}
        />
      </div>

      {/* Inline run result */}
      {runResult !== null && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid rgba(0,255,136,0.1)",
            fontSize: "11px",
            fontFamily: "monospace",
            flexShrink: 0,
            background: runResult.passed
              ? "rgba(0,255,136,0.05)"
              : "rgba(255,68,68,0.05)",
            borderLeft: `3px solid ${runResult.passed ? "#00ff88" : "#ff4444"}`,
          }}
        >
          {runResult.passed ? (
            <span style={{ color: "#00ff88" }}>
              ✓ Sample passed — 1/1
              <span style={{ color: "rgba(200,211,224,0.35)", marginLeft: "8px" }}>
                ({runResult.execution_time_ms}ms)
              </span>
            </span>
          ) : (
            <div style={{ color: "#ff6666" }}>
              <div>✗ Sample failed</div>
              <div style={{ marginTop: "4px", color: "rgba(200,211,224,0.65)" }}>
                Got: <code style={{ color: "#ff9999" }}>{runResult.output || "(empty)"}</code>
              </div>
              <div style={{ color: "rgba(200,211,224,0.65)" }}>
                Expected: <code style={{ color: "#99ff99" }}>{runResult.expected}</code>
              </div>
              {runResult.stderr && (
                <div style={{ color: "#ffa500", marginTop: "4px" }}>
                  {runResult.stderr.slice(0, 150)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiddlePanel — problem statement + opponent feed tabs
// ---------------------------------------------------------------------------
function MiddlePanel({
  problems,
  selectedProblemIdx,
  onSelectProblem,
  solvedProblems,
  opponentCode,
}: {
  problems: ProblemInfo[];
  selectedProblemIdx: number;
  onSelectProblem: (idx: number) => void;
  solvedProblems: Set<number>;
  opponentCode: string;
}) {
  const [tab, setTab] = useState<"problem" | "opponent">("problem");
  const selectedProblem = problems[selectedProblemIdx] ?? null;

  const diffColor = (d: string) =>
    d === "easy" ? "#00cc66" : d === "medium" ? "#ffa500" : "#ff4444";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "rgba(10,12,16,0.95)",
        border: "1px solid rgba(0,255,136,0.15)",
        borderRadius: "8px",
        minHeight: 0,
        height: "100%",
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
        {(["problem", "opponent"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              borderBottom: tab === t ? "2px solid #00ff88" : "2px solid transparent",
              color: tab === t ? "#00ff88" : "rgba(200,211,224,0.35)",
              fontSize: "9px",
              fontFamily: "monospace",
              letterSpacing: "0.15em",
              padding: "10px 4px",
              cursor: "pointer",
              transition: "color 0.2s",
              textTransform: "uppercase",
            }}
          >
            {t === "problem" ? "Problem Statement" : "Opponent Feed"}
          </button>
        ))}
      </div>

      {/* Problem selector strip */}
      {tab === "problem" && problems.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: "4px",
            padding: "6px 10px",
            borderBottom: "1px solid rgba(0,255,136,0.06)",
            flexShrink: 0,
            overflowX: "auto",
          }}
        >
          {problems.map((p, idx) => {
            const isSolved = solvedProblems.has(p.id);
            const isActive = idx === selectedProblemIdx;
            return (
              <button
                key={p.id}
                onClick={() => onSelectProblem(idx)}
                style={{
                  background: "transparent",
                  border: `1px solid ${isActive ? "#00bfff" : "rgba(200,211,224,0.12)"}`,
                  borderRadius: "4px",
                  color: isActive ? "#00bfff" : "rgba(200,211,224,0.45)",
                  fontSize: "10px",
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontFamily: "monospace",
                  letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                  textDecoration: isSolved ? "line-through" : "none",
                  transition: "all 0.15s",
                }}
              >
                {p.difficulty.slice(0, 4).toUpperCase()} {isSolved ? "✓" : ""}
              </button>
            );
          })}
        </div>
      )}

      {/* Content — scrolls inside column (grid/flex min-height:0) */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          WebkitOverflowScrolling: "touch",
          padding: "14px",
        }}
      >
        {tab === "problem" ? (
          selectedProblem ? (
            <div>
              <div style={{ marginBottom: "8px" }}>
                <span
                  style={{
                    fontSize: "9px",
                    fontWeight: "600",
                    color: diffColor(selectedProblem.difficulty),
                    border: `1px solid ${diffColor(selectedProblem.difficulty)}`,
                    borderRadius: "3px",
                    padding: "2px 8px",
                    letterSpacing: "0.1em",
                    fontFamily: "monospace",
                  }}
                >
                  {selectedProblem.difficulty.toUpperCase()}
                </span>
              </div>

              <h2
                style={{
                  color: "#c8d3e0",
                  fontSize: "15px",
                  fontWeight: "700",
                  fontFamily: "monospace",
                  marginBottom: "12px",
                  lineHeight: 1.3,
                }}
              >
                {selectedProblem.title}
              </h2>

              <p
                style={{
                  color: "rgba(200,211,224,0.8)",
                  fontSize: "12px",
                  lineHeight: 1.7,
                  marginBottom: "16px",
                  whiteSpace: "pre-wrap",
                  fontFamily: "sans-serif",
                }}
              >
                {selectedProblem.description}
              </p>

              {[
                { label: "Input Format", text: selectedProblem.input_format },
                { label: "Output Format", text: selectedProblem.output_format },
                { label: "Constraints", text: selectedProblem.constraints },
              ].map(({ label, text }) => (
                <div key={label} style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      fontSize: "9px",
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
                      color: "rgba(200,211,224,0.65)",
                      fontSize: "12px",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "sans-serif",
                    }}
                  >
                    {text}
                  </p>
                </div>
              ))}

              <div style={{ marginBottom: "14px" }}>
                <div
                  style={{
                    fontSize: "9px",
                    color: "#00ff88",
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    marginBottom: "8px",
                    fontFamily: "monospace",
                  }}
                >
                  Example
                </div>
                {[
                  { label: "Input", value: selectedProblem.sample_input },
                  { label: "Output", value: selectedProblem.sample_output },
                ].map(({ label, value }) => (
                  <div key={label} style={{ marginBottom: "8px" }}>
                    <div
                      style={{
                        fontSize: "10px",
                        color: "rgba(200,211,224,0.35)",
                        marginBottom: "3px",
                        fontFamily: "monospace",
                      }}
                    >
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
                        fontFamily: "monospace",
                      }}
                    >
                      {value}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p
              style={{
                color: "rgba(200,211,224,0.3)",
                fontSize: "12px",
                textAlign: "center",
                marginTop: "40px",
              }}
            >
              Select a problem
            </p>
          )
        ) : (
          /* Opponent feed */
          <div>
            <div
              style={{
                fontSize: "9px",
                color: "rgba(200,211,224,0.35)",
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
                border: "1px solid rgba(200,211,224,0.06)",
                borderRadius: "6px",
                padding: "12px",
                minHeight: "200px",
                filter: "blur(6px)",
                userSelect: "none",
                pointerEvents: "none",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                lineHeight: 1.6,
                fontFamily: "monospace",
              }}
            >
              {opponentCode || "// opponent is thinking..."}
            </pre>
            <p
              style={{
                fontSize: "10px",
                color: "rgba(200,211,224,0.2)",
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
  );
}
