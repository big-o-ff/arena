"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, useClerk, useAuth } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../lib/fetchWithAuth";
import TetrisLoading from "@/components/tetris-loader";
import { lobbySocketUrl } from "../../lib/ws";
import { ProfileHoverCard } from "@/components/ProfileHoverCard";

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
  total_wins: number;
  total_losses: number;
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
        .catch(() => { });
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
        } catch (e) { }
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
          type="button"
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

  const pendingReceived = requestHistory.filter(r => r.status === "pending" && r.direction === "received");

  return (
    <div style={{ height: "100vh", background: "#000", color: "#eaeaea", fontFamily: "'Share Tech Mono', monospace", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* ═══ INCOMING INVITE OVERLAY ═══ */}
      {incomingInvite && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.85)" }}>
          <div style={{ border: "1.5px solid #39FF14", background: "#000", padding: "32px", width: 340, textAlign: "center" }}>
            <h3 style={{ color: "#39FF14", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", fontSize: 13, marginBottom: 12 }}>Incoming Challenge</h3>
            <p style={{ fontSize: 12, color: "#999", marginBottom: 4 }}><strong style={{ color: "#fff" }}>{incomingInvite.from_username}</strong> wants to battle you!</p>
            <p style={{ fontSize: 10, color: "#555", marginBottom: 16 }}>Time remaining: {timeLeft}s</p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button type="button" onClick={() => handleRequestAction(incomingInvite.id, "accept")} style={{ padding: "8px 20px", border: "1px solid #39FF14", background: "transparent", color: "#39FF14", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer" }}>Accept</button>
              <button type="button" onClick={() => handleRequestAction(incomingInvite.id, "decline")} style={{ padding: "8px 20px", border: "1px solid #ff4444", background: "transparent", color: "#ff4444", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer" }}>Decline</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ TOP HEADER ═══ */}
      <header style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.2em", margin: 0 }}>
            Lobby <span style={{ color: "#39FF14" }}>//</span> <span style={{ color: "#39FF14" }}>Matchmaking</span>
          </h1>
          <p style={{ fontSize: 11, color: "#555", marginTop: 4 }}>are you the best?</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ProfileHoverCard username={djangoUser.username} wins={djangoUser.total_wins} losses={djangoUser.total_losses}>
            <button type="button" style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", padding: "8px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: "#eaeaea", cursor: "pointer" }}>Profile</button>
          </ProfileHoverCard>
          <button type="button" onClick={() => signOut({ redirectUrl: "/" })} style={{ fontSize: 10, color: "#555", background: "transparent", border: "none", textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer" }}>Logout</button>
        </div>
      </header>

      {/* ═══ ACTIVE BATTLE BANNER ═══ */}
      {activeBattleBanner && (
        <div style={{ margin: "16px 28px 0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid rgba(57,255,20,0.3)", background: "rgba(57,255,20,0.03)", padding: "12px 20px", flexWrap: "wrap" }}>
          <p style={{ fontSize: 12, color: "#999", margin: 0 }}><span style={{ fontWeight: 600, color: "#39FF14" }}>Active battle</span> — match in progress (#{activeBattleBanner.id}).</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => router.push(`/battle/${activeBattleBanner.id}`)} style={{ border: "1px solid #39FF14", background: "rgba(57,255,20,0.08)", padding: "6px 14px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#39FF14", cursor: "pointer" }}>Resume battle</button>
            <button type="button" onClick={() => { sessionStorage.setItem("arena-lobby-dismiss-active", String(activeBattleBanner.id)); setActiveBattleBanner(null); }} style={{ border: "1px solid rgba(255,255,255,0.1)", background: "transparent", padding: "6px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#777", cursor: "pointer" }}>Stay in lobby</button>
          </div>
        </div>
      )}

      {/* ═══ MAIN 3-COLUMN LAYOUT ═══ */}
      <div style={{ flex: 1, display: "flex", gap: 20, padding: "16px 28px", overflow: "hidden", minHeight: 0 }}>

        {/* ── LEFT COLUMN ── */}
        <div style={{ flex: "0 0 240px", display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
          {/* Pending Requests */}
          <div className="lobby-card" style={{ padding: "16px 20px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", margin: 0, color: "#eaeaea" }}>Pending Requests</h2>
              {pendingReceived.length > 0 && (
                <span style={{ border: "1px solid #39FF14", color: "#39FF14", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{pendingReceived.length}</span>
              )}
            </div>
            {pendingReceived.length === 0 ? (
              <p style={{ fontSize: 11, color: "#555", textAlign: "center", padding: "20px 0" }}>No pending invites.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {pendingReceived.map(row => {
                  const peer = row.from_user;
                  const expiresIn = row.expires_at ? Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)) : null;
                  return (
                    <div key={row.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", paddingBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <ProfileHoverCard username={peer.username}>
                            <span style={{ color: "#39FF14", cursor: "pointer", fontWeight: 500, fontSize: 12 }}>@{peer.username}</span>
                          </ProfileHoverCard>
                          <p style={{ fontSize: 10, color: "#555", marginTop: 2 }}>wants to battle you</p>
                        </div>
                        <div style={{ textAlign: "right", fontSize: 10 }}>
                          <div style={{ color: "#555" }}>{formatRequestWhen(row.created_at)}</div>
                          {expiresIn !== null && <div style={{ color: "#00E5FF", fontWeight: 700 }}>Expires in {expiresIn}s</div>}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button type="button" disabled={historyBusyId !== null} onClick={() => void handleRequestAction(row.id, "accept")} style={{ flex: 1, border: "1px solid #39FF14", background: "transparent", color: "#39FF14", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", padding: "7px 0", cursor: "pointer", opacity: historyBusyId !== null ? 0.4 : 1 }}>{historyBusyId === row.id ? "…" : "Accept"}</button>
                        <button type="button" disabled={historyBusyId !== null} onClick={() => void handleRequestAction(row.id, "decline")} style={{ flex: 1, border: "1px solid #ff4444", background: "transparent", color: "#ff4444", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", padding: "7px 0", cursor: "pointer", opacity: historyBusyId !== null ? 0.4 : 1 }}>{historyBusyId === row.id ? "…" : "Decline"}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* How It Works — BLUE zone */}
          <div className="lobby-card" style={{ padding: "16px 20px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8, flex: 1, minHeight: 0 }}>
            <h2 style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", margin: "0 0 14px", color: "#eaeaea" }}>How It Works</h2>
            {[
              { step: "01", title: "Send Challenge", desc: "Search and send a battle request to your opponent." },
              { step: "02", title: "Accept Battle", desc: "Your opponent accepts — the arena is ready." },
              { step: "03", title: "Victory", desc: "Win the battle and climb the leaderboard." },
            ].map((s, i) => (
              <div key={s.step} style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: i < 2 ? 18 : 0 }}>
                <div style={{ width: 32, height: 32, border: "1px solid rgba(0,229,255,0.3)", display: "flex", alignItems: "center", justifyContent: "center", color: "#00E5FF", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#00E5FF", textTransform: "uppercase", letterSpacing: "0.1em" }}>{s.title}</div>
                  <div style={{ fontSize: 10, color: "#555", marginTop: 3, lineHeight: 1.5 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── CENTER COLUMN — PRIMARY FOCUS ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, alignItems: "center", justifyContent: "center", minWidth: 0, overflow: "hidden" }}>
          {/* Challenge Form */}
          <div className="lobby-card" style={{ padding: "28px", width: "100%", maxWidth: 480, textAlign: "center", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.2em", margin: "0 0 6px" }}>
              <span style={{ color: "#39FF14" }}>//</span> Challenge a Player
            </h2>
            <p style={{ fontSize: 11, color: "#555", marginBottom: 24 }}>Enter your opponent&apos;s exact username.</p>
            <form onSubmit={handleCreateBattle}>
              <input
                style={{ width: "100%", border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.6)", padding: "14px 16px", fontSize: 13, color: "#eaeaea", outline: "none", marginBottom: 16, fontFamily: "inherit", boxSizing: "border-box" }}
                value={opponentUsername}
                onChange={(e) => setOpponentUsername(e.target.value)}
                placeholder="username"
              />
              <button type="submit" disabled={loading} className="lobby-cta" style={{ width: "100%", padding: "14px 0", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.2em", color: "#39FF14", cursor: "pointer", fontFamily: "inherit" }}>
                {loading ? "Allocating resources..." : "Initiate Battle"}
              </button>
            </form>
            {error && <p style={{ fontSize: 11, color: "#ff4444", marginTop: 12 }}>{error}</p>}
            {info && <p style={{ fontSize: 11, color: "#39FF14", marginTop: 12 }}>{info}</p>}
            <p style={{ fontSize: 10, color: "#444", marginTop: 16 }}>TIP: Usernames are case-sensitive</p>
          </div>

          {/* Quote */}
          <div className="lobby-card" style={{ padding: "20px", width: "100%", maxWidth: 480, textAlign: "center", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8 }}>
            <span style={{ color: "rgba(255,255,255,0.12)", fontSize: 22 }}>&ldquo;</span>
            <p style={{ fontSize: 12, color: "#777", textTransform: "uppercase", letterSpacing: "0.15em", lineHeight: 1.8, margin: "8px 0" }}>Nothing worth having<br />comes easy.</p>
            <span style={{ color: "rgba(255,255,255,0.12)", fontSize: 22 }}>&rdquo;</span>
            <div style={{ display: "flex", justifyContent: "center", gap: 4, marginTop: 14 }}>
              {["#ff0050", "#ff6600", "#ffcc00", "#39FF14", "#00E5FF"].map((c, i) => (
                <div key={i} style={{ width: 16, height: 5, borderRadius: 3, background: c, opacity: 0.7 }} />
              ))}
            </div>
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div style={{ flex: "0 0 260px", display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
          {/* Leaderboard */}
          <div className="lobby-card" style={{ padding: "16px 20px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8 }}>
            <h2 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", margin: "0 0 16px", color: "#eaeaea" }}>Leaderboard <span style={{ color: "#39FF14" }}>// Top 5</span></h2>
            {isLeaderboardLoading ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "30px 0" }}><TetrisLoading size="sm" speed="fast" loadingText="Syncing rankings..." /></div>
            ) : (
              <div>
                {leaderboard.slice(0, 5).map((entry: LeaderboardEntry, idx: number) => (
                  <div key={entry.username} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.04)", padding: "10px 0" }}>
                    <span style={{ fontSize: 12, color: "#777" }}>
                      {String(idx + 1).padStart(2, "0")}.{" "}
                      <ProfileHoverCard username={entry.username} wins={entry.total_wins} losses={entry.total_losses}>
                        <span style={{ color: "#39FF14", cursor: "pointer", fontWeight: 500 }}>{entry.display_name}</span>
                      </ProfileHoverCard>
                    </span>
                    <span style={{ fontSize: 11, color: "#555" }}>{entry.total_wins} W / {entry.total_losses} L</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Request History */}
          <div className="lobby-card" style={{ padding: "16px 20px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8, flex: 1, minHeight: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <h2 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", margin: 0, color: "#eaeaea" }}>Requests <span style={{ color: "#39FF14" }}>// History</span></h2>
              <button type="button" onClick={() => void loadRequestHistory()} style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#555", background: "transparent", border: "none", cursor: "pointer" }}>Refresh ↻</button>
            </div>
            <p style={{ fontSize: 10, color: "#444", lineHeight: 1.6, marginBottom: 12 }}>
              <span style={{ color: "#b366ff" }}>newest first</span>
            </p>
            {historyLoading && requestHistory.length === 0 ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "24px 0" }}><TetrisLoading size="sm" speed="fast" loadingText="Loading…" /></div>
            ) : requestHistory.length === 0 ? (
              <p style={{ padding: "16px 0", textAlign: "center", fontSize: 11, color: "#444" }}>No requests yet.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {requestHistory.slice(0, 7).map((row) => {
                  const peer = row.direction === "sent" ? row.to_user : row.from_user;
                  const stColor = row.status === "accepted" ? "#39FF14" : row.status === "pending" ? "#ffcc00" : "#555";
                  return (
                    <li key={row.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", padding: "10px 0", lineHeight: 1.6 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                        <ProfileHoverCard username={peer.username}>
                          <span style={{ color: "#39FF14", cursor: "pointer", fontSize: 11 }}>@{peer.username}</span>
                        </ProfileHoverCard>
                        <span style={{ fontSize: 10, color: "#444", flexShrink: 0 }}>{formatRequestWhen(row.created_at)}</span>
                        <span style={{ fontSize: 10, color: stColor, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, flexShrink: 0 }}>{row.status}</span>
                      </div>
                      {row.status === "pending" && row.direction === "received" && (
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <button type="button" disabled={historyBusyId !== null} onClick={() => void handleRequestAction(row.id, "accept")} style={{ border: "1px solid #39FF14", background: "transparent", color: "#39FF14", fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "4px 10px", cursor: "pointer", opacity: historyBusyId !== null ? 0.4 : 1 }}>{historyBusyId === row.id ? "…" : "Accept"}</button>
                          <button type="button" disabled={historyBusyId !== null} onClick={() => void handleRequestAction(row.id, "decline")} style={{ border: "1px solid #ff4444", background: "transparent", color: "#ff4444", fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "4px 10px", cursor: "pointer", opacity: historyBusyId !== null ? 0.4 : 1 }}>{historyBusyId === row.id ? "…" : "Decline"}</button>
                        </div>
                      )}
                      {row.status === "pending" && row.direction === "sent" && (
                        <div style={{ marginTop: 8 }}>
                          <button type="button" disabled={historyBusyId !== null} onClick={() => void handleCancelRequest(row.id)} style={{ border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#777", fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "4px 10px", cursor: "pointer", opacity: historyBusyId !== null ? 0.4 : 1 }}>{historyBusyId === row.id ? "…" : "Cancel invite"}</button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ═══ FOOTER ═══ */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "12px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, color: "#444", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#39FF14", boxShadow: "0 0 6px #39FF14" }}></span>
          SYSTEM ONLINE
        </div>
        <span style={{ fontWeight: 700, color: "rgba(255,255,255,0.4)", fontSize: 13, letterSpacing: "0.2em" }}>BIG OFF</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>v2.4.0</span>
          <span>SECURE</span>
        </div>
      </footer>
    </div>
  );

}
