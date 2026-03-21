"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "../../../lib/api";

type Profile = {
  username: string;
  display_name: string;
  total_wins: number;
  total_losses: number;
};

type HeatmapEntry = {
  date: string;
  problems_solved: number;
};

export default function ProfilePage() {
  const params = useParams<{ username: string }>();
  const username = params.username;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapEntry[]>([]);

  useEffect(() => {
    if (!username) return;
    api.get(`/api/profile/${username}/`).then((res) => setProfile(res.data));
    // Heatmap endpoint can be added later; for now use placeholder data.
    const today = new Date();
    const fake: HeatmapEntry[] = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      fake.push({
        date: d.toISOString().slice(0, 10),
        problems_solved: Math.floor(Math.random() * 4)
      });
    }
    setHeatmap(fake.reverse());
  }, [username]);

  if (!profile) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-noir-terminal/70 text-sm">Loading profile...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-4">
      <section className="terminal-panel p-4 flex flex-col md:flex-row justify-between gap-4">
        <div className="space-y-2 text-sm">
          <h1 className="text-lg font-semibold">
            {profile.display_name}{" "}
            <span className="text-noir-accent text-xs">@{profile.username}</span>
          </h1>
          <p className="text-noir-terminal/70">
            Record:{" "}
            <span className="text-noir-terminal">
              {profile.total_wins}W / {profile.total_losses}L
            </span>
          </p>
        </div>
      </section>

      <section className="terminal-panel p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-[0.25em] text-noir-accent">
          DSA Heatmap // last 4 weeks
        </h2>
        <div className="grid grid-cols-7 gap-1 text-[8px]">
          {heatmap.map((entry) => {
            const intensity = entry.problems_solved;
            let bg = "bg-noir-border/40";
            if (intensity === 1) bg = "bg-emerald-700/70";
            if (intensity === 2) bg = "bg-emerald-500/80";
            if (intensity >= 3) bg = "bg-emerald-300";
            return (
              <div
                key={entry.date}
                className={`w-4 h-4 rounded-sm ${bg}`}
                title={`${entry.date}: ${entry.problems_solved} solved`}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

