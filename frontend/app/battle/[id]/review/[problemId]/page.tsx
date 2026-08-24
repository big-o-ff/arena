"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../../../../lib/fetchWithAuth";

type DjangoUser = {
  id: number;
  username: string;
  display_name: string;
};

type ReviewUser = {
  id: number;
  username: string;
  display_name: string;
};

type ReviewSubmission = {
  id: number;
  /** Null when the server withheld it — see `hidden`. */
  code: string | null;
  language: string;
  status: string;
  passed_cases: number;
  total_cases: number;
  execution_time_ms: number | null;
  submitted_at: string;
  /** True when this is the opponent's submission and the battle is still live. */
  hidden?: boolean;
};

type ReviewSide = {
  user: ReviewUser;
  submission: ReviewSubmission | null;
};

type MyReward = {
  reward_type: string;
  hp_damage_dealt: number;
  created_at: string;
};

type ReviewPayload = {
  battle_id: number;
  battle_status: string;
  /** Opponent code is only released once the battle is over. */
  opponent_code_visible: boolean;
  problem: { id: number; title: string; difficulty: string };
  my_reward: MyReward | null;
  player1: ReviewSide;
  player2: ReviewSide;
};

type EvalSummary = {
  status?: string;
  passed_cases?: number;
  total_cases?: number;
  all_passed?: boolean;
  error?: string | null;
  round_won?: boolean;
  hp_damage?: number | null;
  reward_saved?: boolean;
  battle_ended?: boolean;
  player1_hp?: number;
  player2_hp?: number;
  opponent_new_hp?: number | null;
};

function statusColor(st: string) {
  if (st === "passed") return "#00ff88";
  if (st === "pending") return "#ffa500";
  if (st === "failed") return "#ff6666";
  if (st === "error")  return "#ff8888";
  return "rgba(200,211,224,0.6)";
}

function CodeBlock({
  label,
  side,
  isMe,
}: {
  label: string;
  side: ReviewSide;
  isMe: boolean;
}) {
  const sub = side.submission;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${
          isMe ? "rgba(0,255,136,0.25)" : "rgba(200,211,224,0.12)"
        }`,
        borderRadius: "6px",
        overflow: "hidden",
        background: "rgba(8,10,14,0.98)",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid rgba(0,255,136,0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <span
          style={{
            color: isMe ? "#00ff88" : "#c8d3e0",
            fontSize: "11px",
            letterSpacing: "0.12em",
            fontFamily: "monospace",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
        <span style={{ color: "rgba(200,211,224,0.45)", fontSize: "10px" }}>
          {side.user.display_name}
        </span>
      </div>
      {!sub ? (
        <div
          style={{
            padding: "24px 16px",
            color: "rgba(200,211,224,0.35)",
            fontSize: "12px",
            fontFamily: "monospace",
          }}
        >
          Not submitted yet.
        </div>
      ) : (
        <>
          <div
            style={{
              padding: "6px 12px",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
              fontSize: "10px",
              fontFamily: "monospace",
              borderBottom: "1px solid rgba(0,255,136,0.06)",
            }}
          >
            <span style={{ color: statusColor(sub.status) }}>
              {sub.status.toUpperCase()}
            </span>
            <span style={{ color: "rgba(200,211,224,0.5)" }}>
              {sub.language}
            </span>
            {sub.total_cases > 0 ? (
              <span style={{ color: "rgba(200,211,224,0.55)" }}>
                {sub.passed_cases}/{sub.total_cases} cases
              </span>
            ) : sub.status === "error" ? (
              <span style={{ color: "#ff8888" }}>no test cases</span>
            ) : null}
            {sub.execution_time_ms != null && (
              <span style={{ color: "rgba(200,211,224,0.45)" }}>
                {sub.execution_time_ms}ms
              </span>
            )}
          </div>
          {sub.code === null ? (
            <div
              style={{
                padding: "24px 16px",
                color: "rgba(200,211,224,0.4)",
                fontSize: "12px",
                fontFamily: "monospace",
                lineHeight: 1.6,
                textAlign: "center",
              }}
            >
              Hidden until the battle ends.
              <div
                style={{
                  fontSize: "10px",
                  color: "rgba(200,211,224,0.25)",
                  marginTop: "6px",
                }}
              >
                Their progress is shown above.
              </div>
            </div>
          ) : (
            <pre
              style={{
                margin: 0,
                padding: "12px",
                flex: 1,
                overflow: "auto",
                maxHeight: "min(70vh, 560px)",
                fontSize: "11px",
                lineHeight: 1.45,
                color: "#c8d3e0",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {sub.code}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

export default function BattleProblemReviewPage() {
  const params = useParams<{ id: string; problemId: string }>();
  const battleId = params.id;
  const problemId = params.problemId;
  const { isSignedIn } = useUser();
  const api = useApiClient();
  const fetchMe = useFetchMe();

  const [djangoUser, setDjangoUser] = useState<DjangoUser | null>(null);
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);

  const load = useCallback(async () => {
    if (!battleId || !problemId) return;
    try {
      const res = await api.get<ReviewPayload>(
        `/api/battles/${battleId}/problems/${problemId}/review/`
      );
      setData(res.data);
      setError(null);
    } catch (e: unknown) {
      // A 404 here means the battle or problem is gone, and the API's generic
      // "Not found." is not worth showing — say what the reader was looking for.
      const response = (e as {
        response?: { status?: number; data?: { detail?: string } };
      })?.response;
      const detail = response?.data?.detail;
      setError(
        response?.status === 404
          ? "That battle or problem no longer exists."
          : typeof detail === "string"
            ? detail
            : "Could not load review."
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, battleId, problemId]);

  useEffect(() => {
    if (!isSignedIn) return;
    fetchMe()
      .then((u: DjangoUser) => setDjangoUser(u))
      .catch(() => {});
  }, [isSignedIn, fetchMe]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!battleId || !problemId) return;
    const raw = sessionStorage.getItem(`arena-eval-${battleId}-${problemId}`);
    if (!raw) return;
    try {
      setEvalSummary(JSON.parse(raw) as EvalSummary);
    } catch {
      /* ignore */
    }
  }, [battleId, problemId]);

  // Poll while anything is still in flight: our own submission is judged
  // asynchronously on the execution queue, and the opponent may not have
  // submitted yet. Stops as soon as there is nothing left to wait for.
  useEffect(() => {
    if (!data || !djangoUser) return;
    const mine =
      data.player1.user.id === djangoUser.id ? data.player1 : data.player2;
    const opp =
      data.player1.user.id === djangoUser.id ? data.player2 : data.player1;

    const myVerdictPending =
      !mine.submission || mine.submission.status === "pending";
    const waitingOnOpponent = !opp.submission;

    if (!myVerdictPending && !waitingOnOpponent) return;

    const interval = setInterval(load, myVerdictPending ? 2000 : 5000);
    return () => clearInterval(interval);
  }, [data, djangoUser, load]);

  // Once our verdict lands, drop the "pending" marker the battle page left.
  useEffect(() => {
    if (!data || !djangoUser) return;
    const mine =
      data.player1.user.id === djangoUser.id ? data.player1 : data.player2;
    if (mine.submission && mine.submission.status !== "pending") {
      try {
        sessionStorage.removeItem(`arena-pending-${battleId}-${problemId}`);
      } catch {
        /* sessionStorage may be unavailable */
      }
    }
  }, [data, djangoUser, battleId, problemId]);

  const me = data && djangoUser
    ? data.player1.user.id === djangoUser.id
      ? data.player1
      : data.player2
    : null;
  const them = data && djangoUser
    ? data.player1.user.id === djangoUser.id
      ? data.player2
      : data.player1
    : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0c10",
        color: "#c8d3e0",
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(0,255,136,0.2); border-radius: 2px; }
      `}</style>

      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div>
          <div
            style={{
              color: "#00ff88",
              fontSize: "11px",
              letterSpacing: "0.25em",
              textTransform: "uppercase",
            }}
          >
            Submission review
          </div>
          {data && (
            <h1 style={{ margin: "6px 0 0", fontSize: "18px", fontWeight: 600 }}>
              {data.problem.title}{" "}
              <span
                style={{
                  fontSize: "11px",
                  color: "rgba(200,211,224,0.45)",
                  fontWeight: 400,
                }}
              >
                ({data.problem.difficulty})
              </span>
            </h1>
          )}
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => load()}
            style={{
              background: "rgba(0,255,136,0.08)",
              border: "1px solid rgba(0,255,136,0.3)",
              color: "#00ff88",
              fontSize: "11px",
              padding: "6px 12px",
              borderRadius: "4px",
              cursor: "pointer",
              fontFamily: "monospace",
            }}
          >
            Refresh
          </button>
          <Link
            href={`/battle/${battleId}`}
            style={{
              color: "#00ff88",
              fontSize: "12px",
              fontFamily: "monospace",
              textDecoration: "none",
              borderBottom: "1px solid rgba(0,255,136,0.35)",
            }}
          >
            ← Back to battle
          </Link>
        </div>
      </header>

      {loading && (
        <p style={{ color: "rgba(200,211,224,0.45)", fontSize: "13px" }}>
          Loading…
        </p>
      )}
      {error && !loading && (
        <p style={{ color: "#ff6666", fontSize: "13px" }}>{error}</p>
      )}

      {(evalSummary || data?.my_reward) && (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: "8px",
            border: "1px solid rgba(0,255,136,0.2)",
            background: "rgba(0,255,136,0.06)",
            fontSize: "12px",
            fontFamily: "monospace",
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: "#00ff88", letterSpacing: "0.2em", marginBottom: "8px" }}>
            JUDGE RESULT
          </div>
          {evalSummary && (
            <>
              {evalSummary.status === "error" ? (
                <div>
                  <span style={{ color: "#ff8888" }}>✗ Evaluation error</span>
                  {evalSummary.error && (
                    <div style={{ color: "#ff8888", marginTop: "6px" }}>
                      {evalSummary.error}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  Tests:{" "}
                  <span style={{ color: "#c8d3e0" }}>
                    {evalSummary.passed_cases ?? 0}/{evalSummary.total_cases ?? 0} passed
                  </span>
                  {evalSummary.all_passed ? (
                    <span style={{ color: "#00ff88", marginLeft: "8px" }}>✓ All correct</span>
                  ) : (
                    <span style={{ color: "#ff6666", marginLeft: "8px" }}>✗ Wrong answer</span>
                  )}
                  {evalSummary.error && evalSummary.error !== "battle_not_active" && (
                    <div style={{ color: "#ff8888", marginTop: "6px" }}>{evalSummary.error}</div>
                  )}
                </div>
              )}
              {evalSummary.round_won && evalSummary.reward_saved && (
                <div style={{ color: "#00ff88", marginTop: "8px" }}>
                  Round win: −{evalSummary.hp_damage} HP to opponent
                  {evalSummary.opponent_new_hp != null &&
                    ` (opponent now ${evalSummary.opponent_new_hp} HP)`}
                </div>
              )}
              {evalSummary.battle_ended && (
                <div style={{ color: "#ffa500", marginTop: "8px" }}>
                  Battle ended — opponent reached 0 HP.
                </div>
              )}
            </>
          )}
          {!evalSummary && data?.my_reward && (
            <div style={{ color: "#00ff88" }}>
              {/* `reward_type` is a Django enum value — "round_first_solve" was
                  being printed to players verbatim. */}
              First to solve this round — {data.my_reward.hp_damage_dealt} HP
              damage to opponent
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <Link
          href="/lobby"
          style={{
            display: "inline-block",
            padding: "10px 20px",
            background: "rgba(0,255,136,0.15)",
            border: "1px solid #00ff88",
            borderRadius: "6px",
            color: "#00ff88",
            fontSize: "11px",
            fontFamily: "monospace",
            letterSpacing: "0.12em",
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          Return to lobby
        </Link>
      </div>

      {data && me && them && (
        <div
          style={{
            display: "flex",
            gap: "16px",
            flex: 1,
            flexWrap: "wrap",
            alignItems: "stretch",
          }}
        >
          <CodeBlock label="You" side={me} isMe />
          <CodeBlock label="Opponent" side={them} isMe={false} />
        </div>
      )}
    </div>
  );
}
