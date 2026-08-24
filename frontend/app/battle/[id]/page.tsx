"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth, useUser } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../../lib/fetchWithAuth";
import { battleSocketUrl } from "../../../lib/ws";
import {
  useReconnectingSocket,
  type SocketStatus,
} from "../../../lib/useReconnectingSocket";
import { GCButton } from "../../../components/GCButton";

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
  /**
   * The caller's own progress, so a remount can rebuild what the live socket
   * events would otherwise have to replay. Submitting redirects to the review
   * page, which unmounts this screen before ROUND_RESULT lands.
   */
  my_solved_problem_ids?: number[];
  my_submitted_problem_ids?: number[];
  my_sabotage_used?: boolean;
};

type WSMessage = {
  event: string;
  payload: Record<string, any>;
};

/**
 * What the opponent is allowed to know about your editor.
 *
 * The server no longer sends the opposing player the raw buffer — only these
 * derived counts. Full code goes to the spectator stream instead.
 */
type OpponentActivity = {
  chars: number;
  lines: number;
  non_empty_lines: number;
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [myCode, setMyCode] = useState("");
  const [opponentActivity, setOpponentActivity] =
    useState<OpponentActivity | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");
  const [timer, setTimer] = useState(30 * 60);
  const [selectedLanguage, setSelectedLanguage] = useState("python");
  const [selectedProblemIdx, setSelectedProblemIdx] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResigning, setIsResigning] = useState(false);
  const [resignConfirming, setResignConfirming] = useState(false);

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

  /**
   * Adopt a server snapshot, including this player's progress.
   *
   * Merged rather than replaced: a ROUND_RESULT that arrived over the socket a
   * moment ago must not be dropped by a state read that raced it. The server is
   * additive here — nothing un-solves a problem or un-spends a sabotage.
   */
  const applyBattleState = useCallback((b: BattleState) => {
    setBattle(b);
    if (b.my_solved_problem_ids?.length) {
      setSolvedProblems((prev) => new Set([...prev, ...b.my_solved_problem_ids!]));
    }
    if (b.my_submitted_problem_ids?.length) {
      setSubmittedProblems(
        (prev) => new Set([...prev, ...b.my_submitted_problem_ids!])
      );
    }
    if (b.my_sabotage_used) setGcUsed(true);
  }, []);

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
    let cancelled = false;
    api
      .get(`/api/battles/${battleId}/state/`)
      .then((res) => {
        if (!cancelled) {
          applyBattleState(res.data);
          setLoadError(null);
        }
      })
      .catch((err) => {
        // Without this the page sat on "Spinning up battle instance…" forever
        // and raised an unhandled rejection.
        if (cancelled) return;
        const status = err?.response?.status;
        setLoadError(
          status === 403
            ? "You are not a participant in this battle."
            : status === 404
            ? "That battle does not exist."
            : "Could not load the battle. Check that the API is reachable."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [battleId, api, applyBattleState]);

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
      applyBattleState(b);
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
  }, [timer, battleComplete, battleId, battle, api, router, applyBattleState]);

  // ------------------------------------------------------------------
  // Editor change — broadcast every keystroke so spectators see live typing
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // WebSocket — single connection (Clerk token → Django user on WS for code_update player_id)
  // ------------------------------------------------------------------
  const handleSocketMessage = useCallback(
    (raw: unknown) => {
      const msg = raw as WSMessage;
      if (!msg || typeof msg.event !== "string") return;
      const p = msg.payload ?? {};
      const me = djangoUserRef.current;

      switch (msg.event) {
        // HP update — animate bars.
        // Functional update: two events arriving in the same tick would
        // otherwise both build from the same stale snapshot.
        case "HP_UPDATE":
          setBattle((prev) =>
            prev
              ? {
                  ...prev,
                  player1_hp: p.player1_hp ?? prev.player1_hp,
                  player2_hp: p.player2_hp ?? prev.player2_hp,
                }
              : prev
          );
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

        // GC
        case "GC_START":
          if (me && p.target_user_id === me.id) {
            setGcActive(true);
            const seconds = p.duration_seconds ?? 5;
            addToast(
              `⚠ GARBAGE COLLECTION — IDE blanked for ${seconds}s`,
              "danger"
            );
            // Self-clear as well as waiting for GC_END: if no Celery worker is
            // running, the server-side end event never arrives and the overlay
            // would stay up for the rest of the match.
            setTimeout(() => setGcActive(false), seconds * 1000);
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
          setBattle((prev) =>
            prev
              ? {
                  ...prev,
                  status: "completed",
                  winner: p.winner_id ?? prev.winner ?? null,
                  player1_hp: p.player1_final_hp ?? prev.player1_hp,
                  player2_hp: p.player2_final_hp ?? prev.player2_hp,
                }
              : prev
          );
          router.replace(`/battle/${battleId}/ended`);
          break;

        // Opponent progress — counts only. The server no longer sends the
        // opposing player the buffer itself.
        case "OPPONENT_ACTIVITY":
          if (me && p.player_id != null && p.player_id !== me.id) {
            setOpponentActivity({
              chars: p.chars ?? 0,
              lines: p.lines ?? 0,
              non_empty_lines: p.non_empty_lines ?? 0,
            });
          }
          break;

        case "PONG":
        default:
          break;
      }
    },
    [addToast, battleId, router]
  );

  const getSocketUrl = useCallback(async () => {
    if (!battleId) return null;
    const token = await getToken();
    return token ? battleSocketUrl(battleId, token) : null;
  }, [battleId, getToken]);

  const { send: sendSocket } = useReconnectingSocket({
    enabled: Boolean(battleId) && Boolean(isSignedIn),
    getUrl: getSocketUrl,
    onMessage: handleSocketMessage,
    onStatusChange: setSocketStatus,
  });

  // Debounced editor broadcast. Every keystroke used to push the whole document
  // through Redis to the opponent and every spectator; coalescing to ~4 updates
  // a second keeps the live feed smooth at a fraction of the traffic.
  //
  // Declared after the socket hook so it can close over the stable `send`
  // directly rather than reaching through a ref during render.
  const codeSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCode = useRef<string | null>(null);

  const flushCode = useCallback(() => {
    codeSendTimer.current = null;
    const code = pendingCode.current;
    pendingCode.current = null;
    if (code === null) return;
    sendSocket({ type: "code_update", code });
  }, [sendSocket]);

  const handleCodeChange = useCallback(
    (code: string) => {
      setMyCode(code);
      pendingCode.current = code;
      if (codeSendTimer.current === null) {
        codeSendTimer.current = setTimeout(flushCode, 250);
      }
    },
    [flushCode]
  );

  useEffect(
    () => () => {
      if (codeSendTimer.current) clearTimeout(codeSendTimer.current);
    },
    []
  );

  // A dropped socket means HP, fog and battle-end stop arriving. Re-sync from
  // the API once the connection comes back so the board is not left stale.
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (socketStatus === "reconnecting") {
      wasDisconnected.current = true;
      return;
    }
    if (socketStatus === "open" && wasDisconnected.current) {
      wasDisconnected.current = false;
      api
        .get(`/api/battles/${battleId}/state/`)
        .then((res) => applyBattleState(res.data))
        .catch(() => {});
    }
  }, [socketStatus, api, battleId, applyBattleState]);

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

      // Judging now runs on the Celery `execution` queue, so the usual response
      // is 202 with no verdict. The review page polls for the result.
      const evaluation = res.data?.evaluation;
      if (evaluation) {
        try {
          sessionStorage.setItem(
            `arena-eval-${battleId}-${round.problem.id}`,
            JSON.stringify(evaluation)
          );
        } catch {
          /* sessionStorage may be full or unavailable */
        }
        if (evaluation.status === "error") {
          addToast("Evaluation error — check review for details.", "warning");
        } else if (evaluation.all_passed) {
          addToast("All test cases passed! Opening review.", "success");
        } else {
          addToast(
            `${evaluation.passed_cases ?? 0}/${evaluation.total_cases ?? 0} test cases passed — opening review.`,
            "info"
          );
        }
      } else {
        if (res.data?.submission_id) {
          try {
            sessionStorage.setItem(
              `arena-pending-${battleId}-${round.problem.id}`,
              String(res.data.submission_id)
            );
          } catch {
            /* sessionStorage may be full or unavailable */
          }
        }
        addToast("Submitted — judging, opening review.", "info");
      }
      router.push(`/battle/${battleId}/review/${round.problem.id}`);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? "Submission error";
      const msg = typeof detail === "string" ? detail.toLowerCase() : "";
      if (msg.includes("already solved") || msg.includes("being judged")) {
        setSubmittedProblems((prev) => new Set([...prev, round.problem.id]));
        addToast(
          typeof detail === "string" ? detail : "Already submitted.",
          "info"
        );
        router.push(`/battle/${battleId}/review/${round.problem.id}`);
      } else {
        addToast(typeof detail === "string" ? detail : "Submission error", "danger");
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
  // `window.confirm` blocks the whole renderer until it is dismissed, which
  // froze the tab under automation and reads as a browser-chrome dialog dropped
  // into a full-screen themed app. Confirmation is inline, matching GCButton.
  const handleResign = useCallback(async () => {
    if (!battleId || battleComplete || !djangoUser) return;
    setIsResigning(true);
    try {
      const res = await api.post(`/api/battles/${battleId}/resign/`);
      const b = res.data as BattleState;
      applyBattleState(b);
      addToast("You resigned — battle ended.", "warning");
      router.replace(`/battle/${battleId}/ended`);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? "Could not resign";
      addToast(typeof detail === "string" ? detail : "Could not resign", "danger");
    } finally {
      setIsResigning(false);
    }
  }, [battleId, battleComplete, djangoUser, api, addToast, router, applyBattleState]);

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
  if (loadError) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "#0a0c10",
          padding: "24px",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div style={{ fontSize: "22px", marginBottom: "12px" }}>⚠</div>
          <p
            style={{
              color: "#ff8888",
              fontSize: "13px",
              fontFamily: "monospace",
              lineHeight: 1.6,
              marginBottom: "16px",
            }}
          >
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => router.push("/lobby")}
            style={{
              background: "rgba(0,255,136,0.08)",
              border: "1px solid rgba(0,255,136,0.35)",
              borderRadius: "4px",
              color: "#00ff88",
              fontSize: "12px",
              padding: "8px 18px",
              cursor: "pointer",
              fontFamily: "monospace",
              letterSpacing: "0.08em",
            }}
          >
            Back to lobby
          </button>
        </div>
      </div>
    );
  }

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
        flex: "1 1 0%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#0a0c10",
        padding: "24px",
        gap: "16px",
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
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            color: "rgba(200,211,224,0.3)",
            fontSize: "10px",
          }}
        >
          {/* Connection state was previously invisible: a dropped socket looked
              identical to a quiet match. */}
          {socketStatus !== "open" && (
            <span
              style={{
                color: socketStatus === "closed" ? "#ff6666" : "#ffa500",
                letterSpacing: "0.1em",
              }}
            >
              {socketStatus === "closed"
                ? "● disconnected"
                : socketStatus === "reconnecting"
                ? "● reconnecting…"
                : "● connecting…"}
            </span>
          )}
          {problems.length} problems
        </span>
      </div>

      {/* ============ 3-PANEL GRID ============ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "8fr 7fr 5fr",
          gridTemplateRows: "minmax(0, 1fr)",
          flex: "1 1 0%",
          gap: "8px",
          minHeight: 0,
          alignItems: "stretch",
          overflow: "hidden",
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
        <div
          style={{
            minHeight: 0,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <MiddlePanel
            problems={problems}
            selectedProblemIdx={selectedProblemIdx}
            onSelectProblem={setSelectedProblemIdx}
            solvedProblems={solvedProblems}
            opponentActivity={opponentActivity}
            opponentName={oppName}
          />
        </div>

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
                  type="button"
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
            {resignConfirming ? (
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
                    lineHeight: 1.4,
                  }}
                >
                  Resign? Your opponent wins and ratings update.
                </p>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setResignConfirming(false);
                      void handleResign();
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
                    YES — RESIGN
                  </button>
                  <button
                    type="button"
                    onClick={() => setResignConfirming(false)}
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
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setResignConfirming(true)}
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditorPane — left panel editor + run/submit actions
// ---------------------------------------------------------------------------

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
  onRun: (code: string, lang: string, pid: number) => Promise<RunResult | null>;
  onSubmit: () => void;
}) {
  const monacoLanguage =
    language === "cpp" ? "cpp" : language === "javascript" ? "javascript" : "python";

  const [isRunning, setIsRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runCooldown, setRunCooldown] = useState(false);

  // Clear the previous problem's run output when switching problems. The
  // identity checks make this a no-op when there is nothing to clear, so
  // switching problems doesn't force a second render pass.
  useEffect(() => {
    setRunResult((prev) => (prev === null ? prev : null));
    setRunCooldown((prev) => (prev === false ? prev : false));
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
    // Not scrollable: the pane is action bar + editor + result, and the result
    // must stay pinned to the bottom. When this column scrolled, clicking Run
    // wrote the verdict below the fold — the button was at the top, so the
    // feedback looked like nothing had happened at all.
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {actionBar}
      {/* Monaco editor — owns its own scrolling */}
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
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
            // A long stderr must scroll here rather than squeeze the editor.
            maxHeight: "32%",
            overflowY: "auto",
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
  opponentActivity,
  opponentName,
}: {
  problems: ProblemInfo[];
  selectedProblemIdx: number;
  onSelectProblem: (idx: number) => void;
  solvedProblems: Set<number>;
  opponentActivity: OpponentActivity | null;
  opponentName: string;
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
        flex: 1,
        background: "rgba(10,12,16,0.95)",
        border: "1px solid rgba(0,255,136,0.15)",
        borderRadius: "8px",
        minHeight: 0,
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
            type="button"
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
                type="button"
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
          /*
           * Opponent activity.
           *
           * This used to render the opponent's real source behind a CSS blur —
           * which is not a privacy control: the text sat in the DOM, one
           * devtools toggle away. The server now sends only these counts, so
           * there is nothing here to un-blur.
           */
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
              Opponent activity // {opponentName}
            </div>

            {opponentActivity === null ? (
              <p
                style={{
                  color: "rgba(200,211,224,0.3)",
                  fontSize: "12px",
                  fontFamily: "monospace",
                  textAlign: "center",
                  marginTop: "40px",
                }}
              >
                waiting for opponent to start typing…
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {[
                  { label: "Lines written", value: opponentActivity.non_empty_lines },
                  { label: "Total lines", value: opponentActivity.lines },
                  { label: "Characters", value: opponentActivity.chars },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      padding: "10px 12px",
                      background: "rgba(0,0,0,0.4)",
                      border: "1px solid rgba(0,255,136,0.08)",
                      borderRadius: "6px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "10px",
                        color: "rgba(200,211,224,0.45)",
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        fontFamily: "monospace",
                      }}
                    >
                      {label}
                    </span>
                    <span
                      style={{
                        fontSize: "18px",
                        fontWeight: 700,
                        color: "#00ff88",
                        fontFamily: "monospace",
                      }}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p
              style={{
                fontSize: "10px",
                color: "rgba(200,211,224,0.2)",
                textAlign: "center",
                marginTop: "14px",
                lineHeight: 1.5,
                fontFamily: "monospace",
              }}
            >
              opponent source is never sent to you
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
