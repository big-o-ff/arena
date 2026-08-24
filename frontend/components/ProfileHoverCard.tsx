import * as Popover from '@radix-ui/react-popover';
import { useEffect, useState } from 'react';
import { useApiClient } from "../lib/fetchWithAuth";

type DailyActivity = { date: string; count: number };

type ProfileHoverCardProps = {
  username: string;
  wins?: number;
  losses?: number;
  daily_activity?: DailyActivity[];
  children: React.ReactNode;
};

export function ProfileHoverCard({ username, wins, losses, daily_activity, children }: ProfileHoverCardProps) {
  const [open, setOpen] = useState(false);
  const [profileData, setProfileData] = useState<{ wins: number; losses: number; daily: DailyActivity[] } | null>(
    wins !== undefined && losses !== undefined && daily_activity !== undefined
      ? { wins, losses, daily: daily_activity }
      : null
  );
  const api = useApiClient();

  useEffect(() => {
    if (open && !profileData) {
      api.get(`/api/profile/${username}/`)
        .then(res => {
          const data = res.data;
          // The API does not serve activity history yet. This used to fill the
          // gap with `Math.random()`, so every profile showed a year of
          // convincing, entirely invented battle activity — including for
          // brand-new accounts. An empty grid is the honest placeholder.
          setProfileData({
            wins: data.total_wins ?? 0,
            losses: data.total_losses ?? 0,
            daily: data.daily_activity ?? []
          });
        })
        .catch(console.error);
    }
  }, [open, username, api, profileData]);

  // Ensure daily array is exactly 364 days for a 52x7 grid (52*7 = 364)
  const days = profileData?.daily.slice(-364) ?? [];
  const heatmapDisplay =
    days.length === 364
      ? days
      : [...Array(364 - days.length).fill({ date: '', count: 0 }), ...days];
  const hasActivity = days.some((d) => d.count > 0);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span className="cursor-pointer">{children}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content 
          side="top"
          sideOffset={5}
          collisionPadding={16}
          className="z-50 w-[320px] rounded-xl overflow-hidden shadow-2xl relative outline-none font-mono"
          style={{
            background: "linear-gradient(135deg, #e0e0e0 0%, #ffffff 45%, #b0b0b0 50%, #ffffff 55%, #d1d1d1 100%)",
            border: "1px solid rgba(255, 255, 255, 0.4)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          {/* Noise overlay */}
          <div 
            className="absolute inset-0 opacity-[0.15] pointer-events-none mix-blend-overlay"
            style={{
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E\")"
            }}
          />
          
          <div className="relative p-5 text-[#111] flex flex-col items-center">
            {profileData ? (
              <>
                {/* Clerk-derived handles run to ~30 characters. At text-xl with
                    widest tracking they overflowed the fixed 320px card and were
                    clipped at both edges, so the name was unreadable — which is
                    the one thing this card exists to show. */}
                <h2
                  className="w-full text-center text-base font-bold uppercase tracking-wide text-[#222] break-all leading-tight"
                  title={username}
                >
                  @{username}
                </h2>
                <div className="text-[2.5rem] font-black mt-2 mb-4 tracking-tighter text-[#111] drop-shadow-md">
                  {profileData.wins}W <span className="opacity-30 text-xl font-normal">/</span> {profileData.losses}L
                </div>
                
                <div className="w-full mt-2">
                  {!hasActivity && (
                    <div className="text-[9px] uppercase tracking-widest text-black/40 mb-1 text-center">
                      No activity recorded
                    </div>
                  )}
                  <div
                    className="grid gap-[2px] w-full"
                    style={{ gridTemplateColumns: "repeat(52, 1fr)" }}
                  >
                    {heatmapDisplay.map((day, idx) => {
                      let bg = "bg-black/10"; // empty cell
                      let shadow = "none";
                      if (day.count === 1) { bg = "bg-[#39FF14]/40"; shadow = "0 0 2px rgba(57, 255, 20, 0.4)"; }
                      else if (day.count === 2) { bg = "bg-[#39FF14]/60"; shadow = "0 0 4px rgba(57, 255, 20, 0.6)"; }
                      else if (day.count === 3) { bg = "bg-[#39FF14]/80"; shadow = "0 0 6px rgba(57, 255, 20, 0.8)"; }
                      else if (day.count >= 4) { bg = "bg-[#39FF14]"; shadow = "0 0 8px #39FF14"; }
                      
                      return (
                        <div 
                          key={idx}
                          className={`aspect-square rounded-[1px] ${bg}`}
                          style={{ boxShadow: shadow }}
                          title={day.date ? `${day.date}: ${day.count} battles` : ""}
                        />
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-10 opacity-50 text-sm font-bold uppercase tracking-widest">Generating Ticket...</div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
