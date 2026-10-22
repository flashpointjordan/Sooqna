"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useNotifications } from "@/contexts/notification-context";
import { NotificationItem } from "./NotificationItem";

export function NotificationPopover({ onClose, bellRef }: { onClose: () => void; bellRef: RefObject<HTMLButtonElement | null> }) {
  const { items, unreadCount, loading, error, markAllRead } = useNotifications();
  const [tab, setTab] = useState<"all" | "unread">("all");
  const panelRef = useRef<HTMLDivElement>(null);
  const visibleItems = items.filter((item) => tab === "all" || !item.readAt).slice(0, 8);
  const close = useCallback(() => {
    onClose();
    requestAnimationFrame(() => bellRef.current?.focus());
  }, [bellRef, onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (bellRef.current?.contains(target)) return;
      if (panelRef.current && !panelRef.current.contains(target)) close();
    };
    document.addEventListener("keydown", onKey); document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [bellRef, close]);
  return (
    <div data-testid="notification-popover" ref={panelRef} id="notification-popover" role="dialog" aria-label="الإشعارات" className="absolute end-0 top-full z-50 mt-2 w-[min(92vw,380px)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-bold">الإشعارات</h2>
        <button type="button" onClick={() => void markAllRead()} disabled={!unreadCount} className="text-xs font-semibold text-[var(--brand)] disabled:opacity-40">تحديد الكل كمقروء</button>
      </div>
      <div className="flex border-b border-[var(--border)] px-3" role="tablist" aria-label="تصفية الإشعارات">
        <button type="button" role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")} className={`flex-1 border-b-2 px-3 py-2 text-xs font-semibold ${tab === "all" ? "border-[var(--brand)] text-[var(--brand)]" : "border-transparent text-[var(--text-muted)]"}`}>الكل</button>
        <button type="button" role="tab" aria-selected={tab === "unread"} onClick={() => setTab("unread")} className={`flex-1 border-b-2 px-3 py-2 text-xs font-semibold ${tab === "unread" ? "border-[var(--brand)] text-[var(--brand)]" : "border-transparent text-[var(--text-muted)]"}`}>غير مقروءة</button>
      </div>
      {loading ? <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">جارٍ التحميل...</p> : error ? <p className="px-4 py-8 text-center text-sm text-[var(--danger)]">{error}</p> : visibleItems.length ? <div className="max-h-[min(60vh,480px)] overflow-y-auto">{visibleItems.map((item) => <NotificationItem key={item.id} item={item} />)}</div> : <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">لا توجد إشعارات</p>}
      <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3 text-xs">
        <Link href="/me/settings#notifications" onClick={close} className="text-[var(--text-muted)] hover:text-[var(--brand)]">الإعدادات</Link>
        <Link href="/notifications" onClick={close} className="font-semibold text-[var(--brand)]">عرض كل الإشعارات</Link>
      </div>
    </div>
  );
}
