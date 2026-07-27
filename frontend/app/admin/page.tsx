"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser, useAuth } from "@clerk/nextjs";
import { useApiClient, useFetchMe } from "../../lib/fetchWithAuth";
import { adminMonitorSocketUrl } from "../../lib/ws";
import { asList, useReconnectingSocket } from "../../lib/useReconnectingSocket";

type AdminBattle = {
  id: number;
  player1_username: string;
  player2_username: string;
  status: string;
  current_round: number;
  player1_hp: number;
  player2_hp: number;
};

type AdminUser = {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: boolean;
};

type DjangoUser = {
  id: number;
  username: string;
  display_name: string;
  role: "superadmin" | "admin" | "player" | "spectator";
};

export default function AdminDashboardPage() {
  const { isLoaded, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();
  const api = useApiClient();
  const fetchMe = useFetchMe();

  const [djangoUser, setDjangoUser] = useState<DjangoUser | null>(null);
  const [battles, setBattles] = useState<AdminBattle[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);

  // Fetch Django user and check role
  useEffect(() => {
    if (!isSignedIn) return;
    fetchMe()
      .then((u: DjangoUser) => {
        setDjangoUser(u);
        if (u.role !== "admin" && u.role !== "superadmin") {
          router.push("/lobby");
        }
      })
      .catch(() => {});
  }, [isSignedIn, fetchMe, router]);

  // Fetch admin data
  useEffect(() => {
    if (!djangoUser) return;
    if (djangoUser.role !== "admin" && djangoUser.role !== "superadmin") return;
    // These list endpoints are paginated; unwrap the envelope.
    api
      .get("/api/admin/battles/")
      .then((res) => setBattles(asList<AdminBattle>(res.data)))
      .catch(() => setBattles([]));
    api
      .get("/api/admin/users/")
      .then((res) => setUsers(asList<AdminUser>(res.data)))
      .catch(() => setUsers([]));
  }, [djangoUser, api]);

  // WebSocket for live updates. Only staff are admitted to the monitor group
  // now, so a non-admin connecting here is simply closed by the server.
  const isAdmin =
    djangoUser?.role === "admin" || djangoUser?.role === "superadmin";

  const getAdminSocketUrl = useCallback(async () => {
    const token = await getToken();
    return token ? adminMonitorSocketUrl(token) : null;
  }, [getToken]);

  const handleAdminMessage = useCallback((raw: unknown) => {
    const msg = raw as { event?: string; payload?: { battles?: AdminBattle[] } };
    if (msg?.event === "ADMIN_MONITOR_UPDATE" && msg.payload?.battles) {
      setBattles(asList<AdminBattle>(msg.payload.battles));
    }
  }, []);

  useReconnectingSocket({
    enabled: Boolean(isAdmin),
    getUrl: getAdminSocketUrl,
    onMessage: handleAdminMessage,
  });

  const changeRole = async (id: number, role: string) => {
    await api.patch(`/api/admin/users/${id}/role/`, { role });
    const updated = await api.get("/api/admin/users/");
    setUsers(asList<AdminUser>(updated.data));
  };

  if (!isLoaded || !isSignedIn || !djangoUser) {
    return null;
  }

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-4">
      <header className="terminal-panel p-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-noir-accent">
            Admin Console // Bigoff
          </h1>
          <p className="text-xs text-noir-terminal/60">
            Monitoring live battles, users, and submissions.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="terminal-panel p-4 lg:col-span-2">
          <h2 className="text-xs uppercase tracking-[0.25em] text-noir-accent mb-3">
            Live battles
          </h2>
          <div className="space-y-2 text-xs max-h-80 overflow-y-auto">
            {battles.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between border-b border-noir-border/40 pb-1"
              >
                <div>
                  <div className="text-noir-terminal/80">
                    #{b.id} {b.player1_username} vs {b.player2_username}
                  </div>
                  <div className="text-noir-terminal/60">
                    Round {b.current_round} · {b.status}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="hp-bar w-20">
                    <div
                      className="hp-bar-inner"
                      style={{ width: `${b.player1_hp}%` }}
                    />
                  </div>
                  <div className="hp-bar w-20">
                    <div
                      className="hp-bar-inner"
                      style={{ width: `${b.player2_hp}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {battles.length === 0 && (
              <p className="text-noir-terminal/60">No active battles.</p>
            )}
          </div>
        </section>

        <section className="terminal-panel p-4">
          <h2 className="text-xs uppercase tracking-[0.25em] text-noir-accent mb-3">
            Users
          </h2>
          <div className="space-y-2 text-[11px] max-h-80 overflow-y-auto">
            {users.map((u) => (
              <div
                key={u.id}
                className="border-b border-noir-border/40 pb-1 flex items-center justify-between gap-2"
              >
                <div>
                  <div className="text-noir-terminal/80">{u.display_name}</div>
                  <div className="text-noir-terminal/60">
                    @{u.username} · {u.role}
                  </div>
                </div>
                <select
                  value={u.role}
                  onChange={(e) => changeRole(u.id, e.target.value)}
                  className="bg-black/80 border border-noir-border rounded px-1 py-0.5 text-[10px]"
                >
                  <option value="player">player</option>
                  <option value="spectator">spectator</option>
                  <option value="admin">admin</option>
                  <option value="superadmin">superadmin</option>
                </select>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
