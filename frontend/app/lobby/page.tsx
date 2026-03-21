"use client";
"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, useClerk, useAuth } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../lib/fetchWithAuth";
import TetrisLoading from "@/components/tetris-loader";
import { lobbySocketUrl } from "../../lib/ws";

type LeaderboardEntry = {
  username: string;
  display_name: string;
  total_wins: number;
  total_losses: number;
};

type DjangoUser = {
  id: number;
  username: string;
  display_name: string;
  role: "superadmin" | "admin" | "player" | "spectator";
};

type WSInvite = {
  id: number;
  from_username: string;
  expires_at: string;
};

export default function LobbyPage() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const { getToken } = useAuth();
  const api = useApiClient();
  const fetchMe = useFetchMe();

  const [djangoUser, setDjangoUser] = useState<DjangoUser | null>(null);
  const [opponentUsername, setOpponentUsername] = useState<string>("");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [isLeaderboardLoading, setIsLeaderboardLoading] = useState<boolean>(true);
  
  const [incomingInvite, setIncomingInvite] = useState<WSInvite | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.push("/");
    }
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!isSignedIn) return;
    fetchMe()
      .then((u: DjangoUser) => setDjangoUser(u))
      .catch(() => {
        setError("Network Error: Could not sync profile via the database link."); 
      });
  }, [isSignedIn, fetchMe]);

  useEffect(() => {
    setIsLeaderboardLoading(true);
    api
      .get<LeaderboardEntry[]>("/api/leaderboard/")
      .then((res) => {
        setLeaderboard(res.data);
        setIsLeaderboardLoading(false);
      })
      .catch(() => {
        setIsLeaderboardLoading(false);
      });
  }, [api]);

  // WebSocket connection & event handling
  useEffect(() => {
    if (!djangoUser) return;
    
    // Check for an already active battle just once on mount
    api
      .get("/api/battles/active/")
      .then((res) => {
        if (res.status === 200 && res.data?.id) {
          router.push(`/battle/${res.data.id}`);
        }
      })
      .catch(() => {});

    let ws: WebSocket;

    const initWS = async () => {
      const token = await getToken();
      if (!token) return;

      ws = new WebSocket(lobbySocketUrl(token));
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const type = data.type || data.event;
          const payload = data.payload || data;
          
          if (type === "battle_invite") {
            setIncomingInvite({
              id: payload.battle_request_id,
              from_username: payload.from_username,
              expires_at: payload.expires_at,
            });
          }
          else if (type === "invite_declined") {
            setInfo(`${payload.by_username} declined your battle invite.`);
          }
          else if (type === "battle_starting") {
            router.push(`/battle/${payload.battle_id}`);
          }
          else if (type === "invite_expired") {
            setIncomingInvite((prev) => prev?.id === payload.battle_request_id ? null : prev);
            setInfo("Invite expired.");
          }
        } catch (e) {}
      };
    };

    initWS();

    return () => {
      if (ws) ws.close();
    };
  }, [djangoUser, api, router, getToken]);

  // Countdown timer for incoming invite
  useEffect(() => {
    if (!incomingInvite) return;
    const interval = setInterval(() => {
      const expires = new Date(incomingInvite.expires_at).getTime();
      const now = new Date().getTime();
      const diff = Math.max(0, Math.floor((expires - now) / 1000));
      setTimeLeft(diff);
      if (diff === 0) {
        setIncomingInvite(null); // auto-dismiss
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [incomingInvite]);

  const handleCreateBattle = async (e: FormEvent) => {
    e.preventDefault();
    if (!opponentUsername.trim()) {
      setError("Enter an opponent username first.");
      return;
    }
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const { data: opponent } = await api.get(
        `/api/profile/${encodeURIComponent(opponentUsername)}/`
      );
      await api.post("/api/battles/requests/", { opponent_id: opponent.id });
      setInfo(`Invite sent to ${opponent.display_name} — waiting for response...`);
    } catch (err: any) {
      if (err.response?.data?.detail) {
          setError(err.response.data.detail);
      } else {
          setError("Unable to create battle");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAction = async (id: number, action: "accept" | "decline") => {
    try {
      if (action === "accept") {
        await api.post(`/api/battles/requests/${id}/accept/`);
        // WS will handle redirect via BATTLE_STARTING
      } else {
        await api.post(`/api/battles/requests/${id}/decline/`);
        setIncomingInvite(null);
      }
    } catch (err: any) {
      if (err.response?.data?.detail) {
          setError(err.response.data.detail);
      } else {
          setError("Unable to update battle request");
      }
      setIncomingInvite(null);
    }
  };

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black">
        <TetrisLoading size="md" speed="fast" loadingText="Syncing session..." />
      </div>
    );
  }

  if (error && !djangoUser) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-black text-noir-danger space-y-4">
        <p className="font-mono text-xs uppercase tracking-widest">{error}</p>
        <button 
          className="px-4 py-2 border border-noir-danger text-noir-danger hover:bg-noir-danger/10 text-xs uppercase tracking-widest"
          onClick={() => window.location.reload()}
        >
          [ REBOOT LINK ]
        </button>
      </div>
    );
  }

  if (!djangoUser) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black">
        <TetrisLoading size="md" speed="normal" loadingText="Loading profile..." />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col md:flex-row gap-6 px-4 py-6 bg-black text-white min-h-screen">
      <section className="terminal-panel flex-1 p-5 space-y-4 border border-noir-border/40 relative">
        <header className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-lg font-semibold uppercase tracking-widest text-noir-accent">
              Lobby // Matchmaking
            </h1>
            <p className="text-xs text-noir-terminal/60">
              Authenticated as{" "}
              <span className="text-noir-accent">{djangoUser.display_name}</span>{" "}
              [{djangoUser.role}]
            </p>
          </div>
          <div className="flex gap-4">
            <Link
              href={`/profile/${djangoUser.username}`}
              className="text-xs text-noir-accent hover:underline"
            >
              Profile
            </Link>
            <button
              onClick={() => signOut({ redirectUrl: "/" })}
              className="text-xs text-noir-danger hover:underline"
            >
              Logout
            </button>
          </div>
        </header>

        <form onSubmit={handleCreateBattle} className="space-y-3 text-sm">
          <input
            className="w-full rounded border border-noir-border bg-black/70 px-3 py-2 text-noir-terminal focus:outline-none focus:ring-1 focus:ring-noir-accent"
            value={opponentUsername}
            onChange={(e) => setOpponentUsername(e.target.value)}
            placeholder="opponent_id"
          />
          <button
            type="submit"
            disabled={loading}
            className="cyber-btn w-full border-noir-terminal text-noir-terminal hover:bg-noir-terminal/10 disabled:opacity-60"
          >
            {loading ? "Allocating resources..." : "Initiate Battle"}
          </button>
        </form>

        {error && <p className="text-xs text-noir-danger">{error}</p>}
        {info && <p className="text-xs text-noir-accent">{info}</p>}

        {incomingInvite && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-black border-2 border-noir-accent p-6 shadow-2xl z-50 w-80 text-center space-y-4 animate-pulse">
            <h3 className="text-noir-accent font-bold uppercase tracking-widest text-sm">Incoming Challenge</h3>
            <p className="text-xs text-noir-terminal">
              <strong className="text-white">{incomingInvite.from_username}</strong> wants to battle you!
            </p>
            <p className="text-[10px] text-noir-terminal/60">
              Time remaining: {timeLeft}s
            </p>
            <div className="flex gap-4 justify-center mt-4">
              <button
                onClick={() => handleRequestAction(incomingInvite.id, "accept")}
                className="px-4 py-2 border border-noir-accent text-noir-accent hover:bg-noir-accent/20 text-xs font-bold uppercase"
              >
                Accept
              </button>
              <button
                onClick={() => handleRequestAction(incomingInvite.id, "decline")}
                className="px-4 py-2 border border-noir-danger text-noir-danger hover:bg-noir-danger/20 text-xs font-bold uppercase"
              >
                Decline
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="terminal-panel w-full md:w-80 p-5 space-y-3 border border-noir-border/40">
        <h2 className="text-sm font-semibold tracking-[0.2em] uppercase text-noir-accent">
          Leaderboard // Top 10
        </h2>
        {isLeaderboardLoading ? (
          <div className="flex flex-col items-center py-10">
            <TetrisLoading size="sm" speed="fast" loadingText="Syncing rankings..." />
          </div>
        ) : (
          <div className="space-y-1 text-xs max-h-80 overflow-y-auto">
            {leaderboard.slice(0, 10).map((entry: LeaderboardEntry, idx: number) => (
              <div
                key={entry.username}
                className="flex items-center justify-between border-b border-noir-border/20 py-2"
              >
                <span className="text-noir-terminal/80">
                  {String(idx + 1).padStart(2, "0")}.{" "}
                  <span className="text-noir-accent font-medium">{entry.display_name}</span>
                </span>
                <span className="text-noir-terminal/60">
                  {entry.total_wins}W / {entry.total_losses}L
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}