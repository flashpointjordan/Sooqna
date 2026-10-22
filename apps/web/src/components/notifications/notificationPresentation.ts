export type NotificationPresentation = {
  icon: "message" | "listing" | "heart" | "search" | "bell" | "shield";
  label: string;
  color: "brand" | "accent" | "success" | "neutral" | "danger";
};

const PRESENTATIONS: Record<string, NotificationPresentation> = {
  MESSAGE_RECEIVED: { icon: "message", label: "رسالة جديدة", color: "brand" },
  LISTING_APPROVED: { icon: "listing", label: "تمت الموافقة على الإعلان", color: "success" },
  LISTING_REJECTED: { icon: "listing", label: "تحديث على الإعلان", color: "danger" },
  LISTING_EXPIRED: { icon: "listing", label: "انتهى الإعلان", color: "accent" },
  FAVORITE_ADDED: { icon: "heart", label: "إضافة للمفضلة", color: "danger" },
  REVIEW_RECEIVED: { icon: "heart", label: "تقييم جديد", color: "accent" },
  SAVED_SEARCH_MATCH: { icon: "search", label: "نتيجة جديدة لبحثك", color: "brand" },
  SYSTEM_ANNOUNCEMENT: { icon: "bell", label: "إعلان من سوقنا", color: "neutral" },
  SECURITY_ALERT: { icon: "shield", label: "تنبيه أمني", color: "danger" },
};

export function getNotificationPresentation(type: string): NotificationPresentation {
  return PRESENTATIONS[type] ?? { icon: "bell", label: "إشعار", color: "neutral" };
}

export function badgeLabel(unreadCount: number): string | null {
  if (unreadCount <= 0) return null;
  return unreadCount > 99 ? "99+" : String(unreadCount);
}

export function safeNotificationActionUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^\/(?!\/)/.test(url) ? url : null;
}

export function formatRelativeNotificationTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "الآن";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "منذ يوم" : `منذ ${days} يوم`;
}
