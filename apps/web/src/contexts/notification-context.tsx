"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { notificationApi, openNotificationStream } from "@/services/notificationService";
import { initialNotificationState, notificationReducer, type NotificationState } from "@/components/notifications/notificationState";

export type NotificationContextValue = NotificationState & {
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);
const recoverableError = "تعذر تحديث الإشعارات. حاول مرة أخرى.";

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const [state, setState] = useState(initialNotificationState);
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  const runnerRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { stateRef.current = state; }, [state]);

  const refresh = useCallback(async () => {
    if (!currentUser) return;
    setState((value) => notificationReducer(value, { type: "LOADING", value: true }));
    try {
      const result = await notificationApi.list({ limit: 20 });
      if (mountedRef.current) setState((value) => notificationReducer(value, { type: "HYDRATE", items: result.items, unreadCount: result.unreadCount }));
    } catch {
      if (mountedRef.current) setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError }));
    }
  }, [currentUser]);

  const runStream = useCallback(async () => {
    if (!currentUser || typeof document === "undefined" || document.visibilityState !== "visible" || !navigator.onLine) return;
    if (runnerRef.current) return runnerRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const runner = (async () => {
      try {
        await openNotificationStream({ signal: controller.signal, onSignal: (signal) => {
          setState((value) => notificationReducer(value, { type: "SIGNAL_COUNT", unreadCount: signal.unreadCount }));
          void refresh();
        }, onDisconnect: () => setState((value) => notificationReducer(value, { type: "RECONNECTING", value: true })) });
      } catch { /* disconnects are retried by lifecycle events */ }
      finally { if (controllerRef.current === controller) controllerRef.current = null; }
    })();
    const wrapped = runner.finally(() => {
      if (runnerRef.current === wrapped) runnerRef.current = null;
    });
    runnerRef.current = wrapped;
    return wrapped;
  }, [currentUser, refresh]);

  useEffect(() => {
    mountedRef.current = true;
    if (!currentUser) {
      controllerRef.current?.abort();
      runnerRef.current = null;
      setState(initialNotificationState);
      return () => { mountedRef.current = false; };
    }
    void refresh().then(() => runStream());
    const stop = () => controllerRef.current?.abort();
    const resume = () => { if (document.visibilityState === "visible" && navigator.onLine) void refresh().then(() => runStream()); };
    window.addEventListener("offline", stop);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      window.removeEventListener("offline", stop);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [currentUser, refresh, runStream]);

  const markRead = useCallback(async (id: string) => {
    const previous = stateRef.current;
    setState((value) => notificationReducer(value, { type: "MARK_READ_OPTIMISTIC", id }));
    try { await notificationApi.markRead(id); } catch { setState((value) => notificationReducer(value, { type: "MARK_READ_ROLLBACK", previous })); setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError })); }
  }, []);
  const markAllRead = useCallback(async () => {
    const previous = stateRef.current;
    setState((value) => notificationReducer(value, { type: "MARK_ALL" }));
    try { await notificationApi.markAllRead(); } catch { setState((value) => notificationReducer(value, { type: "MARK_READ_ROLLBACK", previous })); setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError })); }
  }, []);
  const remove = useCallback(async (id: string) => {
    const previous = stateRef.current;
    setState((value) => notificationReducer(value, { type: "DELETE_OPTIMISTIC", id }));
    try { await notificationApi.remove(id); } catch { setState((value) => notificationReducer(value, { type: "DELETE_ROLLBACK", previous })); setState((value) => notificationReducer(value, { type: "ERROR", message: recoverableError })); }
  }, []);

  return <NotificationContext.Provider value={{ ...state, refresh, markRead, markAllRead, remove }}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error("useNotifications must be used within NotificationProvider");
  return context;
}
