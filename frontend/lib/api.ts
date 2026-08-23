const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/**
 * Fetch helper for unauthenticated GET requests (e.g. leaderboard, public battle state).
 * For authenticated requests, use `useApiClient()` from lib/fetchWithAuth.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}
