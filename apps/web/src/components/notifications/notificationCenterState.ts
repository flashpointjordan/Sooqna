import type { NotificationCategory, NotificationItemDto } from "@/types/notification";

export type CenterNotificationItem = NotificationItemDto;
export type NotificationFilter = { category: NotificationCategory | "ALL"; unreadOnly: boolean };

export function filterNotificationItems(items: CenterNotificationItem[], filter: NotificationFilter) {
  return items.filter((item) => (filter.category === "ALL" || item.category === filter.category) && (!filter.unreadOnly || !item.readAt));
}

function localDay(value: Date) { return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime(); }

export function groupNotificationItems(items: CenterNotificationItem[], now = new Date()) {
  const today = localDay(now);
  const yesterday = today - 86_400_000;
  return items.reduce<{ today: CenterNotificationItem[]; yesterday: CenterNotificationItem[]; earlier: CenterNotificationItem[] }>((groups, item) => {
    const day = localDay(new Date(item.createdAt));
    if (day === today) groups.today.push(item);
    else if (day === yesterday) groups.yesterday.push(item);
    else groups.earlier.push(item);
    return groups;
  }, { today: [], yesterday: [], earlier: [] });
}

export function appendNotificationPage(existing: CenterNotificationItem[], next: CenterNotificationItem[]) {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...next.filter((item) => !seen.has(item.id))];
}

export function mergeNotificationPreferences(current: Record<string, boolean>, patch: Record<string, boolean>) {
  const merged = { ...current, ...patch };
  merged.SYSTEM = true;
  merged.SECURITY = true;
  return merged;
}
