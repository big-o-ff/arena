"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
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

type ProfileMini = {
  username: string;
  display_name: string;
};

type BattleRequestHistoryItem = {
  id: number;
  direction: "sent" | "received";
  status: string;
  created_at: string;
  expires_at: string | null;
  from_user: ProfileMini;
  to_user: ProfileMini;
};

function formatRequestWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusStyle(s: string) {
  switch (s) {
    case "pending":
      return "text-amber-400";
    case "accepted":
      return "text-emerald-400";
    case "declined":
    case "expired":
    case "cancelled":
      return "text-noir-terminal/50";
    default:
      return "text-noir-terminal/70";
  }
}

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
  const [historyBusyId, setHistoryBusyId] = useState<number | null>(null);
  const [requestHistory, setRequestHistory] = useState<BattleRequestHistoryItem[]>(
    []
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  /** Active battle from API — shown as a banner instead of auto-redirecting. */
  const [activeBattleBanner, setActiveBattleBanner] = useState<{ id: number } | null>(
    null
  );

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
        setError(
          "Could not reach the Django API (check NEXT_PUBLIC_API_BASE_URL — include :8000 if using runserver, and that CORS allows this origin)."
        );
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

  const loadRequestHistory = useCallback(async () => {
    if (!djangoUser) return;
    setHistoryLoading(true);
    try {
      const { data } = await api.get<BattleRequestHistoryItem[]>(
        "/api/battles/requests/history/"
      );
      setRequestHistory(Array.isArray(data) ? data : []);
    } catch {
      setRequestHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [api, djangoUser]);

  useEffect(() => {
    loadRequestHistory();
  }, [loadRequestHistory]);

  // Poll for active battle — show “Resume” banner (no auto-redirect; user may stay in lobby).
  useEffect(() => {
    if (!djangoUser) return;
    const checkActive = () => {
      api
        .get<{ id: number }>("/api/battles/active/")
        .then((res) => {
          const id = res.data?.id;
          if (res.status === 204 || id == null) {
            setActiveBattleBanner(null);
            return;
          }
          const dismissed = sessionStorage.getItem("arena-lobby-dismiss-active");
          if (dismissed === String(id)) {
            setActiveBattleBanner(null);
            return;
          }
          setActiveBattleBanner({ id });
        })
        .catch(() => {});
    };
    checkActive();
    const interval = setInterval(checkActive, 5000);
    return () => clearInterval(interval);
  }, [djangoUser, api]);

  // WebSocket connection & event handling
  useEffect(() => {
    if (!djangoUser) return;

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
          if (
            type === "battle_invite" ||
            type === "invite_declined" ||
            type === "battle_starting" ||
            type === "invite_expired"
          ) {
            void loadRequestHistory();
          }
        } catch (e) {}
      };
    };

    initWS();

    return () => {
      if (ws) ws.close();
    };
  }, [djangoUser, api, router, getToken, loadRequestHistory]);

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
      void loadRequestHistory();
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 404) {
        setError("No player with that username — use the exact Django username (see leaderboard).");
      } else if (err.response?.data?.detail) {
        setError(err.response.data.detail);
      } else {
        setError("Unable to create battle (check API and network).");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAction = async (id: number, action: "accept" | "decline") => {
    setHistoryBusyId(id);
    setError(null);
    try {
      if (action === "accept") {
        const res = await api.post<{ battle_id: number }>(
          `/api/battles/requests/${id}/accept/`
        );
        setIncomingInvite(null);
        const bid = res.data?.battle_id;
        if (typeof bid === "number") {
          router.push(`/battle/${bid}`);
        }
      } else {
        await api.post(`/api/battles/requests/${id}/decline/`);
        setIncomingInvite(null);
      }
      void loadRequestHistory();
    } catch (err: any) {
      if (err.response?.data?.detail) {
        setError(err.response.data.detail);
      } else {
        setError("Unable to update battle request");
      }
      setIncomingInvite(null);
    } finally {
      setHistoryBusyId(null);
    }
  };

  const handleCancelRequest = async (id: number) => {
    setHistoryBusyId(id);
    setError(null);
    try {
      await api.post(`/api/battles/requests/${id}/cancel/`);
      setInfo("Invite withdrawn.");
      void loadRequestHistory();
    } catch (err: any) {
      if (err.response?.data?.detail) {
        setError(err.response.data.detail);
      } else {
        setError("Unable to cancel invite.");
      }
    } finally {
      setHistoryBusyId(null);
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

        {activeBattleBanner && (
          <div
            role="status"
            className="flex flex-col gap-3 rounded border border-noir-accent/50 bg-noir-accent/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-xs text-noir-terminal">
              <span className="font-semibold text-noir-accent">Active battle</span>{" "}
              — you have a match in progress (#{activeBattleBanner.id}).
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  router.push(`/battle/${activeBattleBanner.id}`)
                }
                className="rounded border border-noir-accent bg-noir-accent/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-noir-accent hover:bg-noir-accent/25"
              >
                Resume battle
              </button>
              <button
                type="button"
                onClick={() => {
                  sessionStorage.setItem(
                    "arena-lobby-dismiss-active",
                    String(activeBattleBanner.id)
                  );
                  setActiveBattleBanner(null);
                }}
                className="rounded border border-noir-border px-3 py-1.5 text-xs uppercase tracking-wider text-noir-terminal/70 hover:bg-white/5"
              >
                Stay in lobby
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleCreateBattle} className="space-y-3 text-sm">
          <p className="text-[10px] text-noir-terminal/50 leading-relaxed">
            Opponent must leave Lobby open to receive the invite (WebSocket). Ensure Redis is running on the API server.
          </p>
          <input
            className="w-full rounded border border-noir-border bg-black/70 px-3 py-2 text-noir-terminal focus:outline-none focus:ring-1 focus:ring-noir-accent"
            value={opponentUsername}
            onChange={(e) => setOpponentUsername(e.target.value)}
            placeholder="opponent username (exact match)"
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

      <aside className="flex w-full flex-col gap-4 md:w-80">
        <section className="terminal-panel space-y-3 border border-noir-border/40 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-noir-accent">
            Leaderboard // Top 10
          </h2>
          {isLeaderboardLoading ? (
            <div className="flex flex-col items-center py-10">
              <TetrisLoading size="sm" speed="fast" loadingText="Syncing rankings..." />
            </div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto text-xs">
              {leaderboard.slice(0, 10).map((entry: LeaderboardEntry, idx: number) => (
                <div
                  key={entry.username}
                  className="flex items-center justify-between border-b border-noir-border/20 py-2"
                >
                  <span className="text-noir-terminal/80">
                    {String(idx + 1).padStart(2, "0")}.{" "}
                    <span className="font-medium text-noir-accent">{entry.display_name}</span>
                  </span>
                  <span className="text-noir-terminal/60">
                    {entry.total_wins}W / {entry.total_losses}L
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="terminal-panel flex max-h-[min(420px,50vh)] flex-col border border-noir-border/40 p-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-noir-accent">
              Requests // History
            </h2>
            <button
              type="button"
              onClick={() => void loadRequestHistory()}
              className="text-[10px] uppercase tracking-widest text-noir-terminal/60 hover:text-noir-accent"
            >
              Refresh
            </button>
          </div>
          <p className="mb-2 text-[10px] text-noir-terminal/45">
            Newest first. For <span className="text-fuchsia-400/80">incoming</span> pending invites,
            use Accept / Decline here if the center popup did not appear (e.g. Redis off). For your
            own pending sends, use Cancel to withdraw and send again.
          </p>
          {historyLoading && requestHistory.length === 0 ? (
            <div className="flex justify-center py-6">
              <TetrisLoading size="sm" speed="fast" loadingText="Loading…" />
            </div>
          ) : requestHistory.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-noir-terminal/40">
              No requests yet.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 text-[11px]">
              {requestHistory.map((row) => {
                const peer =
                  row.direction === "sent" ? row.to_user : row.from_user;
                return (
                  <li
                    key={row.id}
                    className="border-b border-noir-border/25 pb-2 last:border-0"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-noir-terminal/70">
                        <span
                          className={
                            row.direction === "sent"
                              ? "text-cyan-500/90"
                              : "text-fuchsia-400/90"
                          }
                        >
                          {row.direction === "sent" ? "→" : "←"}
                        </span>{" "}
                        @{peer.username}
                      </span>
                      <span
                        className={`shrink-0 uppercase tracking-tighter ${statusStyle(row.status)}`}
                      >
                        {row.status}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-noir-terminal/45">
                      {formatRequestWhen(row.created_at)}
                      {row.status === "pending" && row.expires_at && (
                        <span className="block text-noir-terminal/35">
                          Expires {formatRequestWhen(row.expires_at)}
                        </span>
                      )}
                    </div>
                    {row.status === "pending" && row.direction === "received" && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={historyBusyId !== null}
                          onClick={() => void handleRequestAction(row.id, "accept")}
                          className="rounded border border-noir-accent px-2 py-1 text-[10px] uppercase tracking-wide text-noir-accent hover:bg-noir-accent/15 disabled:opacity-40"
                        >
                          {historyBusyId === row.id ? "…" : "Accept"}
                        </button>
                        <button
                          type="button"
                          disabled={historyBusyId !== null}
                          onClick={() => void handleRequestAction(row.id, "decline")}
                          className="rounded border border-noir-danger px-2 py-1 text-[10px] uppercase tracking-wide text-noir-danger hover:bg-noir-danger/10 disabled:opacity-40"
                        >
                          {historyBusyId === row.id ? "…" : "Decline"}
                        </button>
                      </div>
                    )}
                    {row.status === "pending" && row.direction === "sent" && (
                      <div className="mt-2">
                        <button
                          type="button"
                          disabled={historyBusyId !== null}
                          onClick={() => void handleCancelRequest(row.id)}
                          className="rounded border border-noir-terminal/40 px-2 py-1 text-[10px] uppercase tracking-wide text-noir-terminal/70 hover:bg-white/5 disabled:opacity-40"
                        >
                          {historyBusyId === row.id ? "…" : "Cancel invite"}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}