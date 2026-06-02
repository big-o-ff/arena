"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../../../lib/fetchWithAuth";

const API_BASE =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000"
    : "";

type EndedSummary = {
  battle_id: number;
  ended_reason: string | null;
  winner_id: number | null;
  resigned_by_id: number | null;
  player1: { id: number; display_name: string; username: string };
  player2: { id: number; display_name: string; username: string };
  player1_hp: number;
  player2_hp: number;
  player1_rating_change: number;
  player2_rating_change: number;
  problems_solved: number;
  fastest_solve_time_ms: number | null;
  share_url: string;
};

function reasonLabel(
  ended: string | null,
  meId: number,
  resignedById: number | null
): string {
  if (!ended) return "Match complete";
  if (ended === "resign") {
    if (resignedById === meId) return "You resigned";
    if (resignedById != null) return "Opponent resigned";
    return "Resignation";
  }
  if (ended === "timeout") return "Time expired";
  if (ended === "hp_zero") return "HP depleted";
  return ended.replace(/_/g, " ");
}

export default function BattleEndedPage() {
  const params = useParams<{ id: string }>();
  const battleId = params.id;
  const { isLoaded, isSignedIn } = useUser();
  const api = useApiClient();
  const fetchMe = useFetchMe();

  const [me, setMe] = useState<{ id: number; username: string } | null>(null);
  const [data, setData] = useState<EndedSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !battleId) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      fetchMe() as Promise<{ id: number; username: string }>,
      api.get<EndedSummary>(`/api/battles/${battleId}/ended/`),
    ])
      .then(([u, res]) => {
        if (cancelled) return;
        setMe({ id: u.id, username: u.username });
        setData(res.data);
      })
      .catch((err: { response?: { data?: { detail?: string } } }) => {
        if (cancelled) return;
        const d = err?.response?.data?.detail;
        setError(typeof d === "string" ? d : "Could not load battle report.");
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, battleId, api, fetchMe]);

  if (!isLoaded || !isSignedIn) {
    return null;
  }

  if (error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0a0c10",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          color: "rgba(200,211,224,0.75)",
          fontFamily: "monospace",
          fontSize: "13px",
          padding: "24px",
        }}
      >
        <span>{error}</span>
        <Link href="/lobby" style={{ color: "#00ff88", fontSize: "12px" }}>
          ← Lobby
        </Link>
      </div>
    );
  }

  if (!me || !data) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0a0c10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(200,211,224,0.6)",
          fontFamily: "monospace",
          fontSize: "13px",
        }}
      >
        Loading report…
      </div>
    );
  }

  const iAmP1 = me.id === data.player1.id;
  const myHp = iAmP1 ? data.player1_hp : data.player2_hp;
  const oppHp = iAmP1 ? data.player2_hp : data.player1_hp;
  const myDelta = iAmP1 ? data.player1_rating_change : data.player2_rating_change;
  const oppDelta = iAmP1 ? data.player2_rating_change : data.player1_rating_change;
  const myName = iAmP1 ? data.player1.display_name : data.player2.display_name;
  const oppName = iAmP1 ? data.player2.display_name : data.player1.display_name;
  const won = data.winner_id === me.id;
  const draw = data.winner_id == null;
  const shareHref = data.share_url.startsWith("http")
    ? data.share_url
    : `${API_BASE}${data.share_url}`;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0c10",
        color: "#c8d3e0",
        padding: "24px 16px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "440px",
          border: "1px solid rgba(0,255,136,0.25)",
          borderRadius: "12px",
          padding: "28px 24px",
          background: "rgba(8,10,14,0.95)",
        }}
      >
        <div style={{ fontSize: "10px", letterSpacing: "0.25em", color: "#00ff88", marginBottom: "8px" }}>
          BATTLE #{data.battle_id} · REPORT
        </div>
        <h1
          style={{
            fontSize: "22px",
            margin: "0 0 8px 0",
            color: won ? "#00ff88" : draw ? "#ffa500" : "#ff6666",
            letterSpacing: "0.08em",
          }}
        >
          {won ? "VICTORY" : draw ? "DRAW" : "DEFEAT"}
        </h1>
        <p style={{ fontSize: "11px", color: "rgba(200,211,224,0.45)", margin: "0 0 24px 0", textTransform: "uppercase", letterSpacing: "0.12em" }}>
          {reasonLabel(data.ended_reason, me.id, data.resigned_by_id)}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
          <div style={{ padding: "12px", borderRadius: "8px", background: "rgba(0,0,0,0.35)" }}>
            <div style={{ fontSize: "10px", color: "rgba(200,211,224,0.4)", marginBottom: "6px" }}>You</div>
            <div style={{ fontSize: "13px", color: "#00ff88", marginBottom: "8px" }}>{myName}</div>
            <div style={{ fontSize: "20px", fontWeight: 700 }}>{myHp} HP</div>
            <div style={{ fontSize: "12px", marginTop: "6px", color: myDelta >= 0 ? "#00cc66" : "#ff6666" }}>
              Rating {myDelta >= 0 ? "+" : ""}
              {myDelta}
            </div>
          </div>
          <div style={{ padding: "12px", borderRadius: "8px", background: "rgba(0,0,0,0.35)" }}>
            <div style={{ fontSize: "10px", color: "rgba(200,211,224,0.4)", marginBottom: "6px" }}>Opponent</div>
            <div style={{ fontSize: "13px", marginBottom: "8px" }}>{oppName}</div>
            <div style={{ fontSize: "20px", fontWeight: 700 }}>{oppHp} HP</div>
            <div style={{ fontSize: "12px", marginTop: "6px", color: oppDelta >= 0 ? "#00cc66" : "#ff6666" }}>
              Rating {oppDelta >= 0 ? "+" : ""}
              {oppDelta}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "11px", color: "rgba(200,211,224,0.45)", marginBottom: "20px", lineHeight: 1.5 }}>
          Problems solved (battle): {data.problems_solved}
          {data.fastest_solve_time_ms != null && (
            <> · Fastest solve {data.fastest_solve_time_ms} ms</>
          )}
        </div>

        <a
          href={shareHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "block",
            textAlign: "center",
            padding: "10px",
            marginBottom: "12px",
            border: "1px solid rgba(0,255,136,0.35)",
            borderRadius: "6px",
            color: "#00ff88",
            fontSize: "12px",
            textDecoration: "none",
          }}
        >
          Open share card
        </a>

        <Link
          href="/lobby"
          style={{
            display: "block",
            textAlign: "center",
            padding: "12px",
            borderRadius: "6px",
            background: "rgba(0,255,136,0.12)",
            border: "1px solid rgba(0,255,136,0.35)",
            color: "#00ff88",
            fontSize: "12px",
            letterSpacing: "0.15em",
            textDecoration: "none",
            textTransform: "uppercase",
          }}
        >
          Return to lobby
        </Link>
      </div>
    </div>
  );
}
