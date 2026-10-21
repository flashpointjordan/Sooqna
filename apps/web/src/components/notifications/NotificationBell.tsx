"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useNotifications } from "@/contexts/notification-context";
import { badgeLabel } from "./notificationPresentation";
import { NotificationPopover } from "./NotificationPopover";

export function NotificationBell() {
  const { currentUser } = useAuth();
  const { unreadCount } = useNotifications();
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const badge = badgeLabel(unreadCount);
  if (!currentUser) return null;
  return (
    <div className="relative">
      <button ref={bellRef} type="button" aria-label="الإشعارات" aria-expanded={open} aria-controls="notification-popover" onClick={() => setOpen((value) => !value)} className="relative flex h-10 w-10 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface)] text-lg text-[var(--text)] shadow-[var(--shadow-sm)] transition hover:bg-[var(--chip)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
        <span aria-hidden="true">🔔</span>
        <span className="sr-only" aria-live="polite">{unreadCount ? `${unreadCount} إشعار غير مقروء` : "لا توجد إشعارات غير مقروءة"}</span>
        {badge ? <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[var(--danger)] px-1 text-center text-[10px] font-bold leading-5 text-white">{badge}</span> : null}
      </button>
      {open ? <NotificationPopover onClose={() => setOpen(false)} bellRef={bellRef} /> : null}
    </div>
  );
}
