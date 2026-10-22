"use client";

import { useEffect, useState } from "react";
import { notificationApi } from "@/services/notificationService";
import { mergeNotificationPreferences } from "./notificationCenterState";

const optional = [
  ["MESSAGES", "الرسائل"], ["LISTINGS", "تحديثات الإعلانات"], ["ENGAGEMENT", "التفاعل والتقييمات"], ["SAVED_SEARCHES", "نتائج البحث المحفوظ"],
] as const;
const defaultPreferences = { MESSAGES: true, LISTINGS: true, ENGAGEMENT: true, SAVED_SEARCHES: true, SYSTEM: true, SECURITY: true };

export function NotificationPreferences() {
  const [values, setValues] = useState<Record<string, boolean>>(defaultPreferences);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [warning, setWarning] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void notificationApi.getPreferences().then((result) => { if (active) setValues(mergeNotificationPreferences(defaultPreferences, result.preferences)); }).catch(() => { if (active) setWarning("تعذر تحميل التفضيلات؛ تم تفعيل الإشعارات الاختيارية افتراضيًا."); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function toggle(key: string) { const previous = values; const next = { ...values, [key]: !values[key] }; setValues(next); setSaving(true); setError(null); try { const result = await notificationApi.preferences(mergeNotificationPreferences(next, {})); setValues(mergeNotificationPreferences(next, result.preferences ?? {})); } catch { setValues(previous); setError("تعذر حفظ تفضيلات الإشعارات. حاول مرة أخرى."); } finally { setSaving(false); } }
  if (loading) return <p className="text-sm text-[var(--text-muted)]">جارٍ تحميل تفضيلات الإشعارات...</p>;
  return <section id="notifications" className="ui-card space-y-4 p-5 sm:p-6"><div><h2 className="text-lg font-bold">تفضيلات الإشعارات</h2><p className="mt-1 text-sm text-[var(--text-muted)]">اختر أنواع الإشعارات التي تهمك.</p></div>{warning ? <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</p> : null}{error ? <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p> : null}<div className="space-y-2">{optional.map(([key, label]) => <label key={key} className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-3"><span className="text-sm">{label}</span><input type="checkbox" checked={Boolean(values[key])} disabled={saving} onChange={() => void toggle(key)} /></label>)}{([['SYSTEM', 'إشعارات النظام'], ['SECURITY', 'إشعارات الأمان']] as const).map(([key, label]) => <label key={key} className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3"><span><span className="block text-sm">{label}</span><span className="block text-xs text-[var(--text-muted)]">إشعارات النظام والأمان إلزامية</span></span><input type="checkbox" checked disabled /></label>)}</div></section>;
}
