"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiGet } from "../../../lib/api";

type SharePlayer = { display_name: string; username: string };

type ShareCard = {
  battle_id: number;
  ended_reason: string | null;
  winner_slot: 1 | 2 | null;
  is_draw: boolean;
  player1: SharePlayer;
  player2: SharePlayer;
  player1_hp: number;
  player2_hp: number;
  player1_rating_change: number;
  player2_rating_change: number;
  problems_solved: number;
  fastest_solve_time_ms: number | null;
  ended_at: string;
};

function reasonLabel(ended: string | null): string {
  if (!ended) return "Match complete";
  if (ended === "resign") return "Ended by resignation";
  if (ended === "timeout") return "Time expired";
  if (ended === "hp_zero") return "HP depleted";
  return ended.replace(/_/g, " ");
}

/** Corner brackets — the framing used on the spectate lobby rows. */
function Corners() {
  return (
    <>
      <span className="absolute top-0 left-0 w-3 h-3 border-t border-l border-noir-accent/40" />
      <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-noir-accent/40" />
      <span className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-noir-accent/40" />
      <span className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-noir-accent/40" />
    </>
  );
}

function PlayerBlock({
  player,
  hp,
  delta,
  isWinner,
}: {
  player: SharePlayer;
  hp: number;
  delta: number;
  isWinner: boolean;
}) {
  return (
    <div
      className={`relative p-5 border bg-noir-surface/40 ${
        isWinner ? "border-noir-terminal/40" : "border-noir-border/30"
      }`}
    >
      <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
        {isWinner ? "Winner" : "Player"}
      </div>
      <div
        className={`text-sm mb-1 truncate ${
          isWinner ? "text-noir-terminal" : "text-white"
        }`}
        title={player.display_name || player.username}
      >
        {player.display_name || player.username}
      </div>
      <div className="text-[10px] text-white/35 mb-4 truncate">
        @{player.username}
      </div>
      <div className="text-2xl font-bold text-white tabular-nums">{hp} HP</div>
      <div
        className={`text-xs mt-1.5 tabular-nums ${
          delta >= 0 ? "text-noir-terminal" : "text-noir-danger"
        }`}
      >
        Rating {delta >= 0 ? "+" : ""}
        {delta}
      </div>
    </div>
  );
}

export default function ShareCardPage() {
  const params = useParams<{ uuid: string }>();
  const uuid = params.uuid;

  const [data, setData] = useState<ShareCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uuid) return;
    let cancelled = false;
    apiGet<ShareCard>(`/api/battles/share/${uuid}/`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError("This battle report is not available.");
      });
    return () => {
      cancelled = true;
    };
  }, [uuid]);

  if (error) {
    return (
      <div className="min-h-screen bg-black text-white font-mono flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-xs text-white/50">{error}</p>
        <Link href="/" className="text-xs text-noir-accent hover:underline">
          &larr; Home
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-black text-white font-mono flex items-center justify-center">
        <p className="text-xs text-noir-terminal/40 animate-pulse">
          Decrypting report...
        </p>
      </div>
    );
  }

  const p1Won = data.winner_slot === 1;
  const p2Won = data.winner_slot === 2;
  const winnerName = p1Won
    ? data.player1.display_name || data.player1.username
    : p2Won
      ? data.player2.display_name || data.player2.username
      : null;

  return (
    <div className="min-h-screen bg-black text-white font-mono flex flex-col items-center justify-center p-6">
      <div className="relative w-full max-w-2xl">
        <Corners />
        <div className="p-6 md:p-10 border border-noir-border/30 bg-noir-surface/20">
          <div className="text-[10px] uppercase tracking-widest text-noir-terminal/50 mb-2">
            Battle #{data.battle_id} &middot; Report
          </div>

          <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
            {data.is_draw ? "Draw" : `${winnerName} wins`}
            <span className="text-noir-accent opacity-50 text-xl">{"//"}</span>
          </h1>
          <p className="text-xs text-white/40 uppercase tracking-widest mb-8">
            {reasonLabel(data.ended_reason)}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <PlayerBlock
              player={data.player1}
              hp={data.player1_hp}
              delta={data.player1_rating_change}
              isWinner={p1Won}
            />
            <PlayerBlock
              player={data.player2}
              hp={data.player2_hp}
              delta={data.player2_rating_change}
              isWinner={p2Won}
            />
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-3 text-[11px] text-white/45 border-t border-noir-border/30 pt-5">
            <span>
              Problems solved{" "}
              <span className="text-white/80 tabular-nums">
                {data.problems_solved}
              </span>
            </span>
            {data.fastest_solve_time_ms != null && (
              <span>
                Fastest solve{" "}
                <span className="text-white/80 tabular-nums">
                  {data.fastest_solve_time_ms} ms
                </span>
              </span>
            )}
            <span>
              Ended{" "}
              <span className="text-white/80">
                {new Date(data.ended_at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </span>
          </div>

          <div className="flex items-center justify-between mt-8 pt-5 border-t border-noir-border/30">
            <span className="text-[10px] uppercase tracking-widest text-white/25">
              Big-O-Ff Arena
            </span>
            <Link
              href="/spectate"
              className="text-[11px] text-noir-accent hover:underline"
            >
              Watch live battles &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
