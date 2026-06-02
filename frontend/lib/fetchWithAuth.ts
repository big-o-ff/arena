"use client";

import { useCallback, useMemo } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
import axios, { type AxiosInstance } from "axios";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/** Avoid hanging forever when the API host/port is wrong or unreachable (default axios has no timeout). */
const API_TIMEOUT_MS = 20_000;

/**
 * React hook that returns an Axios instance pre-configured to attach
 * the current Clerk JWT as a Bearer token on every request.
 *
 * Usage:
 *   const api = useApiClient();
 *   const { data } = await api.get("/api/battles/");
 */
export function useApiClient(): AxiosInstance {
  const { getToken } = useAuth();

  const client = useMemo(() => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      timeout: API_TIMEOUT_MS,
    });

    instance.interceptors.request.use(async (config) => {
      const token = await getToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    return instance;
  }, [getToken]);

  return client;
}

/**
 * Convenience helper: fetch the current user's profile from the Django backend.
 * Returns { id, username, display_name, role, ... }.
 */
export function useFetchMe() {
  const api = useApiClient();
  const { user } = useUser();
  
  return useCallback(() => {
    if (!user) return Promise.reject("No user state");

    // Clerk doesn't set a username for Google OAuth accounts, so derive one
    // from their name or email rather than letting it fall back to the Clerk ID.
    const email = user.primaryEmailAddress?.emailAddress ?? "";
    const derivedUsername =
      user.username ||
      (user.firstName && user.lastName
        ? `${user.firstName}${user.lastName}`.toLowerCase().replace(/[^a-z0-9_]/g, "")
        : user.firstName?.toLowerCase().replace(/[^a-z0-9_]/g, "")) ||
      email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "") ||
      undefined;

    return api.post("/api/auth/me/", {
        username: derivedUsername,
        email,
        first_name: user.firstName,
        last_name: user.lastName,
    }).then((r) => r.data);
  }, [api, user]);
}
