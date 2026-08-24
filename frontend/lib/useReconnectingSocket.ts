"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * A WebSocket that comes back after a drop.
 *
 * The previous implementation opened a socket once and, on close, cleared its
 * ping timer and stopped. A single network blip or backend restart left the
 * battle UI silently frozen — no HP updates, no fog, no BATTLE_END — with no
 * indication anything was wrong.
 *
 * Reconnects use exponential backoff with jitter, pause while the tab is hidden
 * or the browser is offline, and stop permanently on the auth/authorisation
 * close codes the consumers send (4401/4403/4404), which will never succeed on
 * retry.
 */

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

/** Close codes our consumers use to reject a connection outright. */
const FATAL_CLOSE_CODES = new Set([4401, 4403, 4404]);

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

type Options = {
  /** Resolves the URL; re-invoked on every attempt so tokens stay fresh. */
  getUrl: () => Promise<string | null>;
  onMessage: (data: unknown) => void;
  onStatusChange?: (status: SocketStatus) => void;
  /**
   * Called with the close code when the server refuses the connection outright
   * (4401/4403/4404), so the UI can say *why* rather than just "unavailable".
   */
  onFatalClose?: (code: number) => void;
  /** Set false to tear the socket down (e.g. while signed out). */
  enabled?: boolean;
};

export function useReconnectingSocket({
  getUrl,
  onMessage,
  onStatusChange,
  onFatalClose,
  enabled = true,
}: Options): { send: (data: unknown) => boolean } {
  const socketRef = useRef<WebSocket | null>(null);

  // Held in refs so a changing callback identity never forces a reconnect.
  const getUrlRef = useRef(getUrl);
  const onMessageRef = useRef(onMessage);
  const onStatusChangeRef = useRef(onStatusChange);
  const onFatalCloseRef = useRef(onFatalClose);
  useEffect(() => {
    getUrlRef.current = getUrl;
    onMessageRef.current = onMessage;
    onStatusChangeRef.current = onStatusChange;
    onFatalCloseRef.current = onFatalClose;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let socket: WebSocket | null = null;

    const setStatus = (status: SocketStatus) => {
      if (!cancelled) onStatusChangeRef.current?.(status);
    };

    const clearTimers = () => {
      if (retryTimer) clearTimeout(retryTimer);
      if (pingTimer) clearInterval(pingTimer);
      retryTimer = null;
      pingTimer = null;
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      setStatus("reconnecting");
      // Full jitter: avoids every client in a battle retrying in lockstep after
      // a backend restart.
      const capped = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      const delay = Math.random() * capped;
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const connect = async () => {
      if (cancelled) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        scheduleReconnect();
        return;
      }

      setStatus(attempt === 0 ? "connecting" : "reconnecting");

      let url: string | null = null;
      try {
        url = await getUrlRef.current();
      } catch {
        url = null;
      }
      if (cancelled) return;
      if (!url) {
        scheduleReconnect();
        return;
      }

      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setStatus("open");
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ event: "PING", payload: {} }));
          }
        }, PING_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        try {
          onMessageRef.current(JSON.parse(event.data));
        } catch {
          // A malformed frame must not kill the handler for every later frame.
        }
      };

      socket.onclose = (event) => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        if (cancelled) return;

        if (FATAL_CLOSE_CODES.has(event.code)) {
          setStatus("closed");
          if (!cancelled) onFatalCloseRef.current?.(event.code);
          return;
        }
        scheduleReconnect();
      };

      socket.onerror = () => {
        // `onclose` always follows; reconnect is scheduled there.
      };
    };

    const handleOnline = () => {
      if (socketRef.current?.readyState === WebSocket.OPEN) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempt = 0;
      void connect();
    };

    void connect();
    window.addEventListener("online", handleOnline);

    return () => {
      cancelled = true;
      clearTimers();
      window.removeEventListener("online", handleOnline);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socketRef.current = null;
    };
  }, [enabled]);

  /** Stable across reconnects; returns false when the socket isn't open. */
  const send = useCallback((data: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(data));
    return true;
  }, []);

  return { send };
}

/** Extracts a list from either a bare array or a DRF paginated envelope. */
export function asList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as any).results)) {
    return (data as any).results as T[];
  }
  return [];
}
