"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { spectatorSocketUrl } from "../../../lib/ws";
import { api } from "../../../lib/api";

type BattleState = {
  id: number;
  player1: { display_name: string };
  player2: { display_name: string };
  player1_hp: number;
  player2_hp: number;
  current_round: number;
};

const EMOTES = ["🔥", "🤖", "💀", "⚔️", "🚀", "🐍"];

export default function SpectatePage() {
  const params = useParams<{ id: string }>();
  const battleId = params.id;

  const [battle, setBattle] = useState<BattleState | null>(null);
  const [messageLog, setMessageLog] = useState<string[]>([]);

  useEffect(() => {
    if (!battleId) return;
    api.get(`/api/battles/${battleId}/state/`).then((res) => setBattle(res.data));
  }, [battleId]);

  useEffect(() => {
    const ws = new WebSocket(spectatorSocketUrl(battleId));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.event === "SPECTATOR_EMOTE") {
        setMessageLog((log) => [
          `[${msg.payload.username || "anon"}] ${msg.payload.emote}`,
          ...log
        ]);
      }
      if (msg.event === "HP_UPDATE" && battle) {
        setBattle({
          ...battle,
          player1_hp: msg.payload.player1_hp,
          player2_hp: msg.payload.player2_hp
        });
      }
    };
    return () => ws.close();
  }, [battleId, battle]);

  const sendEmote = (emote: string) => {
    const ws = new WebSocket(spectatorSocketUrl(battleId));
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          event: "SPECTATOR_EMOTE",
          payload: { emote }
        })
      );
      ws.close();
    };
  };

  if (!battle) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-noir-terminal/70 text-sm">Tuning into arena feed...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col md:flex-row gap-4 px-4 py-4">
      <section className="terminal-panel flex-1 p-4 space-y-3">
        <header className="flex items-center justify-between text-xs">
          <div>
            <div className="text-noir-accent/80 uppercase tracking-[0.25em]">
              Spectate // Battle #{battle.id}
            </div>
            <div className="text-noir-terminal/60">
              Round {battle.current_round} / 3
            </div>
          </div>
        </header>
        <div className="space-y-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-noir-terminal/80">
              {battle.player1.display_name}
            </span>
            <div className="hp-bar w-40">
              <div className="hp-bar-inner" style={{ width: `${battle.player1_hp}%` }} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-noir-terminal/80">
              {battle.player2.display_name}
            </span>
            <div className="hp-bar w-40">
              <div className="hp-bar-inner" style={{ width: `${battle.player2_hp}%` }} />
            </div>
          </div>
        </div>
        <div className="mt-4 text-xs text-noir-terminal/70">
          Live code feeds and round breakdown panels can be added here using the same
          WebSocket channel as the players.
        </div>
      </section>

      <aside className="terminal-panel w-full md:w-72 p-4 flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-noir-accent">
          Emotes // Pixel rail
        </h2>
        <div className="flex flex-wrap gap-2">
          {EMOTES.map((emote) => (
            <button
              key={emote}
              onClick={() => sendEmote(emote)}
              className="w-10 h-10 flex items-center justify-center rounded bg-black/70 border border-noir-border hover:border-noir-accent text-lg pixel-emote"
            >
              {emote}
            </button>
          ))}
        </div>
        <div className="mt-3 text-xs text-noir-terminal/70">
          Recent emotes:
          <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
            {messageLog.map((msg, idx) => (
              <div key={idx}>{msg}</div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

