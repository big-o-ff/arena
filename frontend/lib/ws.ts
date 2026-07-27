const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_BASE_URL || "ws://localhost:8000";

/** Matches `JWTAuthMiddleware` — `?token=` so battle/spectate WS get `scope.user`. */
function withWsToken(path: string, token?: string) {
  const base = `${WS_BASE_URL.replace(/\/$/, "")}${path}`;
  if (!token) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

/** @param token Clerk session JWT — required for authenticated `player_id` on `code_update`. */
export function battleSocketUrl(battleId: string | number, token?: string) {
  return withWsToken(`/ws/battles/${battleId}/`, token);
}

export function spectatorSocketUrl(battleId: string | number, token?: string) {
  return withWsToken(`/ws/battles/${battleId}/spectate/`, token);
}

export function lobbySocketUrl(token: string) {
  return withWsToken("/ws/lobby/", token);
}

/** Same path as lobby; dashboard consumer joins the admin_monitor group. */
export function adminMonitorSocketUrl(token: string) {
  return lobbySocketUrl(token);
}

