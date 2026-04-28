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
    <div className="min-h-screen bg-black text-white font-mono flex flex-col">
      {/* Top Bar Area */}
      <div className="p-6 md:p-8 max-w-7xl mx-auto w-full flex-1">
        <div className="flex flex-col md:flex-row items-start md:items-end justify-between gap-6 mb-10">
          <div>
            <div className="text-noir-terminal/50 text-[10px] uppercase tracking-widest mb-2">Spectate Lobby</div>
            <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
              Live battles <span className="text-noir-accent opacity-50 text-xl">//</span>
            </h1>
            <p className="text-xs text-noir-terminal/60">
              Watch real players in action. Every match is live.
            </p>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <button className="flex items-center gap-2 border border-noir-accent/30 text-noir-accent px-4 py-2 hover:bg-noir-accent/10 transition-colors">
              Filter
            </button>
            <button className="flex items-center gap-2 border border-noir-border/50 text-white px-4 py-2 hover:bg-white/5 transition-colors">
              Newest &#9660;
            </button>
            <Link href="/" className="flex items-center gap-2 text-noir-accent hover:underline ml-4">
              &larr; Home
            </Link>
          </div>
        </div>

        {err && <p className="text-red-500 text-xs">{err}</p>}
        {rows === null && !err && (
          <p className="text-noir-terminal/40 text-xs animate-pulse">Scanning frequencies...</p>
        )}
        {rows && rows.length === 0 && !err && (
          <p className="text-noir-terminal/50 text-xs">No active battles right now. Check back soon.</p>
        )}
        {rows && rows.length > 0 && (
          <ul className="flex flex-col gap-4">
            {rows.map((b) => (
              <li key={b.id} className="relative group">
                {/* Corner decors for the row */}
                <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-noir-accent/40 group-hover:border-noir-accent transition-colors"></div>
                <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-noir-accent/40 group-hover:border-noir-accent transition-colors"></div>
                <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-noir-accent/40 group-hover:border-noir-accent transition-colors"></div>
                <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-noir-accent/40 group-hover:border-noir-accent transition-colors"></div>

                <Link
                  href={`/spectate/${b.id}`}
                  className="block p-5 border border-noir-border/30 bg-noir-surface/40 hover:bg-noir-surface/80 hover:border-noir-accent/30 transition-all duration-300"
                >
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    {/* Battle ID & Live */}
                    <div className="flex-shrink-0 w-24">
                      <div className="font-mono text-[10px] text-white/80 tracking-widest mb-1.5">
                        BATTLE #{b.id}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-noir-accent font-bold">
                        <span className="w-1.5 h-1.5 rounded-full bg-noir-accent animate-pulse shadow-[0_0_5px_#39FF14]"></span>
                        LIVE
                      </div>
                    </div>

                    {/* Players */}
                    <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 flex items-center justify-center border border-noir-accent/30 text-noir-accent font-bold text-sm relative">
                          <div className="absolute top-0 left-0 w-1 h-1 border-t border-l border-noir-accent"></div>
                          <div className="absolute bottom-0 right-0 w-1 h-1 border-b border-r border-noir-accent"></div>
                          {b.player1.display_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm text-white">{b.player1.display_name}</span>
                      </div>
                      <span className="text-[10px] text-noir-terminal/40 mx-2 hidden sm:block">vs</span>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 flex items-center justify-center border border-noir-accent/30 text-noir-accent font-bold text-sm relative">
                           <div className="absolute top-0 left-0 w-1 h-1 border-t border-l border-noir-accent"></div>
                           <div className="absolute bottom-0 right-0 w-1 h-1 border-b border-r border-noir-accent"></div>
                           {b.player2.display_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm text-white">{b.player2.display_name}</span>
                      </div>
                    </div>

                    {/* HP Bars */}
                    <div className="flex-shrink-0 w-full lg:w-48 text-[10px] space-y-2 mt-4 lg:mt-0">
                      <div className="text-noir-terminal/40 hidden lg:block">HP</div>
                      <div className="flex items-center gap-3">
                        <span className="w-16 text-white text-right">{Math.max(0, b.player1_hp)} / 100</span>
                        <div className="flex-1 h-1.5 bg-noir-border/50 rounded-full overflow-hidden">
                          <div className="h-full bg-noir-accent shadow-[0_0_8px_#39FF14]" style={{ width: `${Math.max(0, b.player1_hp)}%` }}></div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="w-16 text-white text-right">{Math.max(0, b.player2_hp)} / 100</span>
                        <div className="flex-1 h-1.5 bg-noir-border/50 rounded-full overflow-hidden">
                          <div className="h-full bg-noir-accent shadow-[0_0_8px_#39FF14]" style={{ width: `${Math.max(0, b.player2_hp)}%` }}></div>
                        </div>
                      </div>
                    </div>

                    {/* Round & Spectators */}
                    <div className="flex-shrink-0 w-28 text-xs space-y-1.5 hidden md:block">
                      <div className="text-noir-terminal/70">Round {b.current_round}</div>
                      <div className="text-noir-terminal/50 text-[10px]">
                        {b.spectator_likes} watching
                      </div>
                    </div>

                    {/* Watch Button */}
                    <div className="flex-shrink-0 mt-4 lg:mt-0">
                      <button className="w-full lg:w-auto px-6 py-2.5 border border-noir-accent text-noir-accent text-xs uppercase tracking-widest hover:bg-noir-accent/10 transition-colors flex items-center justify-center gap-2">
                        WATCH <span className="text-[10px]">&gt;</span>
                      </button>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer Bar */}
      <div className="border-t border-noir-border/40 p-4 text-[10px] text-noir-terminal/40 flex justify-between items-center px-8">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-noir-accent shadow-[0_0_5px_#39FF14]"></span>
          SYSTEM ONLINE
        </div>
        <div className="flex items-center gap-4">
          <span>v2.4.0</span>
          <span className="flex items-center gap-1">
            SECURE
          </span>
        </div>
      </div>
    </div>
  );
}
