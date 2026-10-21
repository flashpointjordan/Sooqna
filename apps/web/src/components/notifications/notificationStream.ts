import type { NotificationSignal } from "@/types/notification";

export class SseParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];

  push(chunk: string): NotificationSignal[] {
    this.buffer += chunk;
    const events: NotificationSignal[] = [];
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") {
        const value = this.data.join("\n");
        if (this.event === "notification.changed" && value) {
          try {
            const parsed = JSON.parse(value) as NotificationSignal;
            if (parsed.event === "notification.changed" && typeof parsed.notificationId === "string" && Number.isInteger(parsed.unreadCount) && parsed.version === 1) events.push(parsed);
          } catch { /* malformed frames are ignored */ }
        }
        this.event = "message";
        this.data = [];
      } else if (line.startsWith(":")) {
        continue;
      } else if (line.startsWith("event:")) {
        this.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).trimStart());
      }
    }
    return events;
  }
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt)) + Math.floor(random() * 500);
}

export function shouldConnect({ user, visibilityState, online }: { user: { uid: string } | null; visibilityState: "visible" | "hidden"; online: boolean }): boolean {
  return Boolean(user?.uid && visibilityState === "visible" && online);
}
