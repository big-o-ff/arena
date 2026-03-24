"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";

type LiveBattle = {
  id: number;
  player1: { display_name: string; username: string };
  player2: { display_name: string; username: string };
  player1_hp: number;
  player2_hp: number;
  spectator_likes: number;
  current_round: number;
};

export default function SpectateLobbyPage() {
  const [rows, setRows] = useState<LiveBattle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<LiveBattle[]>("/api/battles/live/")
      .then((r) => {
        if (!cancelled) {
          setRows(r.data);
          setErr(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErr("Could not load live battles.");
          setRows([]);
        }
      });
    const t = setInterval(() => {
      api.get<LiveBattle[]>("/api/battles/live/").then((r) => {
        if (!cancelled) setRows(r.data);
      });
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0c10",
        color: "#c8d3e0",
        padding: "24px",
        maxWidth: "900px",
        margin: "0 auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "24px",
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
            Spectate lobby
          </div>
          <h1 style={{ margin: "8px 0 0", fontSize: "22px", fontWeight: 600 }}>
            Live battles
          </h1>
        </div>
        <Link
          href="/"
          style={{
            color: "#00ff88",
            fontSize: "12px",
            fontFamily: "monospace",
            textDecoration: "none",
            borderBottom: "1px solid rgba(0,255,136,0.35)",
          }}
        >
          ← Home
        </Link>
      </div>

      {err && <p style={{ color: "#ff6666", fontSize: "13px" }}>{err}</p>}
      {rows === null && !err && (
        <p style={{ color: "rgba(200,211,224,0.45)" }}>Loading…</p>
      )}
      {rows && rows.length === 0 && !err && (
        <p style={{ color: "rgba(200,211,224,0.5)", fontSize: "14px" }}>
          No active battles right now. Check back soon.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
          {rows.map((b) => (
            <li key={b.id}>
              <Link
                href={`/spectate/${b.id}`}
                style={{
                  display: "block",
                  padding: "16px 18px",
                  borderRadius: "8px",
                  border: "1px solid rgba(0,255,136,0.2)",
                  background: "rgba(8,10,14,0.95)",
                  textDecoration: "none",
                  color: "inherit",
                  transition: "border-color 0.15s",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "12px",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <span style={{ color: "#00ff88", fontFamily: "monospace", fontSize: "12px" }}>
                      BATTLE #{b.id}
                    </span>
                    <div style={{ marginTop: "6px", fontSize: "14px" }}>
                      <span style={{ color: "#c8d3e0" }}>{b.player1.display_name}</span>
                      <span style={{ color: "rgba(200,211,224,0.35)", margin: "0 8px" }}>vs</span>
                      <span style={{ color: "#c8d3e0" }}>{b.player2.display_name}</span>
                    </div>
                    <div style={{ marginTop: "8px", fontSize: "11px", color: "rgba(200,211,224,0.45)" }}>
                      Round {b.current_round} · ♥ {b.spectator_likes} likes
                    </div>
                  </div>
                  <div style={{ fontSize: "11px", fontFamily: "monospace", color: "rgba(200,211,224,0.5)" }}>
                    HP {b.player1_hp} — {b.player2_hp}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
