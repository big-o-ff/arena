import axios from "axios";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/**
 * Bare axios instance for unauthenticated requests (e.g. leaderboard).
 * For authenticated requests, use `useApiClient()` from lib/fetchWithAuth.
 */
export const api = axios.create({
  baseURL: API_BASE_URL,
});
