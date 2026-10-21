"use client";

import { useRouter } from "next/navigation";
import type { NotificationItemDto } from "@/types/notification";
import { useNotifications } from "@/contexts/notification-context";
import { formatRelativeNotificationTime, getNotificationPresentation, safeNotificationActionUrl } from "./notificationPresentation";

const iconText: Record<string, string> = { message: "✉", listing: "▣", heart: "♥", search: "⌕", bell: "🔔", shield: "⚿" };

export function NotificationItem({ item }: { item: NotificationItemDto }) {
  const router = useRouter();
  const { markRead, remove } = useNotifications();
  const presentation = getNotificationPresentation(item.type);
  const actionUrl = safeNotificationActionUrl(item.actionUrl);
  const activate = () => {
    if (!item.readAt) void markRead(item.id);
    router.push(actionUrl ?? "/notifications");
  };
  return (
    <div className={`group relative flex w-full gap-3 border-b border-[var(--border)] px-4 py-3 text-right transition hover:bg-[var(--surface-muted)] ${item.readAt ? "" : "bg-[var(--chip)]/30"}`}>
      <button type="button" onClick={activate} className="flex min-w-0 flex-1 items-start gap-3 text-right focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]" aria-label={item.title}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--chip)] text-lg" aria-hidden="true">{iconText[presentation.icon]}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {!item.readAt ? <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]" aria-label="غير مقروء" /> : null}
            <span className="truncate text-sm font-semibold text-[var(--text)]">{item.title}</span>
          </span>
          <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">{item.body}</span>
          <time className="mt-1 block text-[10px] text-[var(--text-muted)]" dateTime={item.createdAt}>{formatRelativeNotificationTime(item.createdAt)}</time>
        </span>
      </button>
      <button type="button" onClick={() => void remove(item.id)} aria-label="حذف الإشعار" className="h-8 w-8 shrink-0 rounded-full text-[var(--text-muted)] opacity-70 transition hover:bg-[var(--chip)] hover:text-[var(--danger)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">⋯</button>
    </div>
  );
}
