import { apiBase, apiFetch, getAuthHeader } from "@/services/apiClient";
import type { NotificationItemDto, NotificationSignal } from "@/types/notification";

type ListResponse = { items: NotificationItemDto[]; nextCursor: string | null; unreadCount: number };

export const notificationApi = {
  list(params: { limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    return apiFetch<ListResponse>(`/notifications${query.size ? `?${query}` : ""}`, { authenticated: true });
  },
  unreadCount() { return apiFetch<{ unreadCount: number }>("/notifications/unread-count", { authenticated: true }); },
  markRead(id: string) { return apiFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST", authenticated: true }); },
  markAllRead() { return apiFetch("/notifications/read-all", { method: "POST", authenticated: true }); },
  remove(id: string) { return apiFetch(`/notifications/${encodeURIComponent(id)}`, { method: "DELETE", authenticated: true }); },
  preferences(preferences: Record<string, boolean>) { return apiFetch("/notifications/preferences", { method: "PUT", body: JSON.stringify(preferences), authenticated: true }); },
};

export async function openNotificationStream({ signal, onSignal, onDisconnect }: { signal?: AbortSignal; onSignal: (value: NotificationSignal) => void; onDisconnect?: (error?: unknown) => void }): Promise<void> {
  try {
    const response = await fetch(`${apiBase()}/notifications/stream`, { headers: { Accept: "text/event-stream", ...(await getAuthHeader()) }, signal });
    if (!response.ok || !response.body) throw new Error(`Notification stream failed with ${response.status}`);
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
