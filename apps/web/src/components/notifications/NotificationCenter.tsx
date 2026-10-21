"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { notificationApi } from "@/services/notificationService";
import { useNotifications } from "@/contexts/notification-context";
import { NotificationItem } from "./NotificationItem";
import { appendNotificationPage, filterNotificationItems, groupNotificationItems, type NotificationFilter } from "./notificationCenterState";
import type { NotificationCategory } from "@/types/notification";

const categories: Array<{ key: NotificationCategory | "ALL"; label: string }> = [
  { key: "ALL", label: "الكل" }, { key: "MESSAGES", label: "الرسائل" }, { key: "LISTINGS", label: "الإعلانات" },
  { key: "ENGAGEMENT", label: "التفاعل" }, { key: "SAVED_SEARCHES", label: "البحث المحفوظ" }, { key: "SYSTEM", label: "النظام" }, { key: "SECURITY", label: "الأمان" },
];

export function NotificationCenter() {
  const router = useRouter();
  const { currentUser, loading: authLoading } = useAuth();
  const { items, unreadCount, nextCursor, loading, error, refresh, markAllRead } = useNotifications();
  const [filter, setFilter] = useState<NotificationFilter>({ category: "ALL", unreadOnly: false });
  const [cursor, setCursor] = useState<string | null>(null);
  const [allItems, setAllItems] = useState(items);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setAllItems(items); setCursor(nextCursor); }, [items, nextCursor]);
  useEffect(() => { if (!authLoading && currentUser === null) router.replace(`/login?next=%2Fnotifications`); }, [authLoading, currentUser, router]);
  const visible = useMemo(() => filterNotificationItems(allItems, filter), [allItems, filter]);
  const groups = useMemo(() => groupNotificationItems(visible), [visible]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await notificationApi.list({ limit: 20, cursor: cursor ?? undefined });
      setAllItems((current) => appendNotificationPage(current, result.items));
      setCursor(result.nextCursor);
    } finally { setLoadingMore(false); }
  }

  const renderGroup = (label: string, values: typeof visible) => values.length ? <section key={label} aria-labelledby={`notification-group-${label}`}>
    <h2 id={`notification-group-${label}`} className="mb-2 mt-6 text-sm font-bold text-[var(--text-muted)]">{label}</h2>
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">{values.map((item) => <NotificationItem key={item.id} item={item} />)}</div>
  </section> : null;

  if (authLoading || !currentUser) return <div className="rounded-2xl border border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">جارٍ التحقق من الجلسة...</div>;
  return <div className="grid gap-6 md:grid-cols-[190px_minmax(0,1fr)]" dir="rtl">
    <aside className="hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 md:block">
      <h2 className="mb-3 px-2 text-sm font-bold">التصنيفات</h2>
      <div className="space-y-1">{categories.map((category) => <button key={category.key} type="button" onClick={() => setFilter((value) => ({ ...value, category: category.key }))} className={`w-full rounded-xl px-3 py-2 text-right text-sm ${filter.category === category.key ? "bg-[var(--chip)] font-bold text-[var(--brand)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"}`}>{category.label}</button>)}</div>
    </aside>
    <section className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-full gap-2 overflow-x-auto pb-1 md:hidden">{categories.map((category) => <button key={category.key} type="button" onClick={() => setFilter((value) => ({ ...value, category: category.key }))} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs ${filter.category === category.key ? "border-[var(--brand)] bg-[var(--chip)] text-[var(--brand)]" : "border-[var(--border)]"}`}>{category.label}</button>)}</div>
        <div className="flex items-center gap-2 text-xs"><button type="button" onClick={() => setFilter((value) => ({ ...value, unreadOnly: false }))} className={!filter.unreadOnly ? "font-bold text-[var(--brand)]" : "text-[var(--text-muted)]"}>الكل</button><span>·</span><button type="button" onClick={() => setFilter((value) => ({ ...value, unreadOnly: true }))} className={filter.unreadOnly ? "font-bold text-[var(--brand)]" : "text-[var(--text-muted)]"}>غير مقروءة ({unreadCount})</button></div>
        <button type="button" onClick={() => void markAllRead()} disabled={!unreadCount} className="text-xs font-semibold text-[var(--brand)] disabled:opacity-40">تحديد الكل كمقروء</button>
      </div>
      {typeof navigator !== "undefined" && !navigator.onLine ? <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">لا يوجد اتصال حاليًا. ستتم إعادة المحاولة عند عودة الاتصال.</div> : null}
      {error ? <div className="mb-3 flex items-center justify-between rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"><span>{error}</span><button type="button" onClick={() => void refresh()} className="font-bold">إعادة المحاولة</button></div> : null}
      {loading && !allItems.length ? <div className="rounded-2xl border border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">جارٍ تحميل الإشعارات...</div> : visible.length ? <>{renderGroup("اليوم", groups.today)}{renderGroup("أمس", groups.yesterday)}{renderGroup("سابقًا", groups.earlier)}</> : <div className="rounded-2xl border border-dashed border-[var(--border)] p-12 text-center text-sm text-[var(--text-muted)]">لا توجد إشعارات مطابقة.</div>}
      {cursor ? <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="mt-5 w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-50">{loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}</button> : null}
      <div className="mt-6 text-center text-xs text-[var(--text-muted)]"><Link href="/me/settings#notifications" className="hover:text-[var(--brand)]">إعدادات الإشعارات</Link></div>
    </section>
  </div>;
}
