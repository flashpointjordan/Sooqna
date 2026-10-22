import { apiBase, apiFetch, getAuthHeader } from "@/services/apiClient";
import type { NotificationItemDto, NotificationSignal } from "@/types/notification";

type ListResponse = { items: NotificationItemDto[]; nextCursor: string | null; unreadCount: number };
type ApiSuccess<T> = { success: true; data: T };
type Preferences = Record<string, boolean>;

async function notificationFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await apiFetch<ApiSuccess<T>>(path, { ...options, authenticated: true });
  return response.data;
}

export const notificationApi = {
  async list(params: { limit?: number; cursor?: string } = {}): Promise<ListResponse> {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    const [page, count] = await Promise.all([
      notificationFetch<Omit<ListResponse, "unreadCount">>(`/notifications${query.size ? `?${query}` : ""}`),
      notificationFetch<{ unreadCount: number }>("/notifications/unread-count"),
    ]);
    return { ...page, unreadCount: count.unreadCount };
  },
  unreadCount() { return notificationFetch<{ unreadCount: number }>("/notifications/unread-count"); },
  markRead(id: string) { return notificationFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: "PATCH" }); },
  markAllRead() { return notificationFetch("/notifications/read-all", { method: "POST" }); },
  remove(id: string) { return notificationFetch(`/notifications/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  async getPreferences() { return { preferences: await notificationFetch<Preferences>("/notifications/preferences") }; },
  async preferences(preferences: Preferences) {
    const optional = Object.fromEntries(["MESSAGES", "LISTINGS", "ENGAGEMENT", "SAVED_SEARCHES"]
      .filter((key) => typeof preferences[key] === "boolean").map((key) => [key, preferences[key]]));
    return { preferences: await notificationFetch<Preferences>("/notifications/preferences", { method: "PUT", body: JSON.stringify(optional) }) };
  },
};

export async function openNotificationStream({ signal, onSignal, onDisconnect, onOpen }: { signal?: AbortSignal; onSignal: (value: NotificationSignal) => void; onDisconnect?: (error?: unknown) => void; onOpen?: () => void }): Promise<void> {
  try {
    const response = await fetch(`${apiBase()}/notifications/stream`, { headers: { Accept: "text/event-stream", ...(await getAuthHeader()) }, signal });
    if (!response.ok || !response.body) throw new Error(`Notification stream failed with ${response.status}`);
    onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const { SseParser } = await import("@/components/notifications/notificationStream");
    const parser = new SseParser();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      for (const value of parser.push(decoder.decode(item.value, { stream: true }))) onSignal(value);
    }
  } catch (error) {
    onDisconnect?.(error);
    throw error;
  }
}
