const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_BASE_URL || "ws://localhost:8000";

export function battleSocketUrl(battleId: string | number) {
  return `${WS_BASE_URL.replace(/\/$/, "")}/ws/battles/${battleId}/`;
}

export function spectatorSocketUrl(battleId: string | number) {
  return `${WS_BASE_URL.replace(/\/$/, "")}/ws/battles/${battleId}/spectate/`;
}

export function lobbySocketUrl(token: string) {
  return `${WS_BASE_URL.replace(/\/$/, "")}/ws/lobby/?token=${token}`;
}

/** Same path as lobby; dashboard consumer joins the admin_monitor group. */
export function adminMonitorSocketUrl(token: string) {
  return lobbySocketUrl(token);
}

