"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { notificationApi, openNotificationStream } from "@/services/notificationService";
import { initialNotificationState, notificationReducer, type NotificationState } from "@/components/notifications/notificationState";
import { NotificationLifecycle } from "@/components/notifications/notificationLifecycle";

export type NotificationContextValue = NotificationState & {
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);
const recoverableError = "تعذر تحديث الإشعارات. حاول مرة أخرى.";

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  // Remounting clears both visible state and pending callbacks when the account changes.
  return <NotificationSession key={currentUser?.uid ?? "signed-out"} userId={currentUser?.uid ?? null}>{children}</NotificationSession>;
}

function NotificationSession({ children, userId }: { children: ReactNode; userId: string | null }) {
  const [state, setState] = useState(initialNotificationState);
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const activeRef = useRef(false);
  const refreshRef = useRef<Promise<void> | null>(null);
  const pageRef = useRef<Promise<void> | null>(null);
  const refreshRevisionRef = useRef(0);
  useEffect(() => { stateRef.current = state; }, [state]);

  const refresh = useCallback(async () => {
    if (!userId || !activeRef.current) return;
    if (refreshRef.current) return refreshRef.current;
    refreshRevisionRef.current += 1;
    const generation = generationRef.current;
    const valid = () => activeRef.current && generationRef.current === generation;
    setState((value) => notificationReducer(value, { type: "LOADING", value: true }));
    const pending = (async () => {
      try {
        const result = await notificationApi.list({ limit: 20 });
        if (valid()) setState((value) => notificationReducer(value, { type: "HYDRATE", items: result.items, unreadCount: result.unreadCount, nextCursor: result.nextCursor }));
      } catch {
        if (valid()) setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError }));
      }
    })();
    const wrapped = pending.finally(() => { if (refreshRef.current === wrapped) refreshRef.current = null; });
    refreshRef.current = wrapped;
    return wrapped;
  }, [userId]);

  const loadMore = useCallback(async () => {
    if (!userId || !activeRef.current || !stateRef.current.nextCursor) return;
    if (refreshRef.current) return refreshRef.current;
    if (pageRef.current) return pageRef.current;
    const generation = generationRef.current;
    const revision = refreshRevisionRef.current;
    const cursor = stateRef.current.nextCursor;
    const valid = () => activeRef.current && generationRef.current === generation && refreshRevisionRef.current === revision;
    setState((value) => notificationReducer(value, { type: "LOADING", value: true }));
    const pending = (async () => {
      try {
        const result = await notificationApi.list({ limit: 20, cursor });
        if (valid()) setState((value) => notificationReducer(value, { type: "APPEND_PAGE", items: result.items, nextCursor: result.nextCursor }));
      } catch {
        if (valid()) setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError }));
      }
    })();
    const wrapped = pending.finally(() => { if (pageRef.current === wrapped) pageRef.current = null; });
    pageRef.current = wrapped;
    return wrapped;
  }, [userId]);

  useEffect(() => {
    activeRef.current = true;
    const generation = ++generationRef.current;
    const valid = () => activeRef.current && generationRef.current === generation;
    const lifecycle = new NotificationLifecycle({
      canConnect: () => Boolean(valid() && userId && document.visibilityState === "visible" && navigator.onLine),
      refresh,
      connect: (signal) => openNotificationStream({ signal, onOpen: () => { if (valid() && !signal.aborted) lifecycle.connected(); }, onSignal: (event) => {
        if (!valid() || signal.aborted) return;
        lifecycle.connected();
        setState((value) => notificationReducer(value, { type: "SIGNAL_COUNT", unreadCount: event.unreadCount }));
        void refresh();
      } }),
      onReconnect: () => { if (valid()) setState((value) => notificationReducer(value, { type: "RECONNECTING", value: true })); },
    });
    const sync = () => {
      if (document.visibilityState === "visible" && navigator.onLine) lifecycle.resume();
      else lifecycle.pause();
    };
    sync();
    window.addEventListener("offline", sync);
    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      activeRef.current = false;
      generationRef.current += 1;
      refreshRef.current = null;
      pageRef.current = null;
      lifecycle.dispose();
      window.removeEventListener("offline", sync);
      window.removeEventListener("online", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [userId, refresh]);

  const mutate = useCallback(async (operation: () => Promise<unknown>, optimistic: Parameters<typeof notificationReducer>[1], rollback: "MARK_READ_ROLLBACK" | "DELETE_ROLLBACK") => {
    if (!userId || !activeRef.current) return;
    const generation = generationRef.current;
    const previous = stateRef.current;
    setState((value) => notificationReducer(value, optimistic));
    try { await operation(); }
    catch {
      if (!activeRef.current || generationRef.current !== generation) return;
      setState((value) => notificationReducer(value, { type: rollback, previous }));
      setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError }));
    }
  }, [userId]);
  const markRead = useCallback((id: string) => mutate(() => notificationApi.markRead(id), { type: "MARK_READ_OPTIMISTIC", id }, "MARK_READ_ROLLBACK"), [mutate]);
  const markAllRead = useCallback(() => mutate(() => notificationApi.markAllRead(), { type: "MARK_ALL" }, "MARK_READ_ROLLBACK"), [mutate]);
  const remove = useCallback((id: string) => mutate(() => notificationApi.remove(id), { type: "DELETE_OPTIMISTIC", id }, "DELETE_ROLLBACK"), [mutate]);

  return <NotificationContext.Provider value={{ ...state, refresh, loadMore, markRead, markAllRead, remove }}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error("useNotifications must be used within NotificationProvider");
  return context;
}
