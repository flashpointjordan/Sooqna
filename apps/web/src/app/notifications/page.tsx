import type { Metadata } from "next";
import { PublicShell } from "@/components/layout/PublicShell";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import { noIndexMetadata } from "@/lib/seo";

export const metadata: Metadata = noIndexMetadata("الإشعارات", "مركز إشعارات سوقنا.");

export default function NotificationsPage() {
  return <PublicShell pageTitle="الإشعارات" pageDescription="تابع رسائلك وتحديثات إعلاناتك وتفاعلات السوق."><NotificationCenter /></PublicShell>;
}
