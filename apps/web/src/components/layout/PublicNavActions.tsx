"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { ModernAvatar } from "@/components/ui/ModernAvatar";
import { NotificationBell } from "@/components/notifications/NotificationBell";

export function PublicNavActions() {
  const router = useRouter();
  const pathname = usePathname();
  const { currentUser, loading, logout } = useAuth();
  const homeClassName =
    pathname === "/"
      ? "rounded-full bg-[var(--brand)] px-4 py-2 text-xs font-semibold text-[var(--brand-contrast)] shadow-[var(--shadow-sm)]"
      : "rounded-full border border-[var(--chip-border)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold text-[var(--text-muted)] shadow-[var(--shadow-sm)] transition hover:bg-[var(--chip)] hover:text-[var(--brand)]";
  const homeLink = (
    <Link href="/" className={homeClassName}>
      الرئيسية
    </Link>
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        {homeLink}
        <span className="text-xs text-[var(--text-muted)]">...</span>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="flex items-center gap-2">
        {homeLink}
        <Link
          href="/login"
          className="rounded-full bg-[var(--brand)] px-5 py-2 text-xs font-semibold text-[var(--brand-contrast)] transition hover:opacity-90"
        >
          تسجيل الدخول
        </Link>
        <span className="text-xs text-[var(--text-muted)]">أو</span>
        <Link
          href="/register"
          className="rounded-full border border-[var(--chip-border)] bg-[var(--surface)] px-5 py-2 text-xs font-semibold text-[var(--brand)] transition hover:bg-[var(--chip)]"
        >
          إنشاء حساب
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {homeLink}
      <div className="hidden sm:block">
        <ModernAvatar
          src={currentUser.photoURL}
          name={currentUser.displayName || currentUser.email?.split("@")[0] || "مستخدم"}
          size="sm"
          status="online"
          verified={Boolean(currentUser.emailVerified)}
        />
      </div>
      <NotificationBell />
      <Link
        href="/me"
        className="rounded-full bg-[var(--brand)] px-4 py-2 text-xs font-semibold text-[var(--brand-contrast)] shadow-[var(--shadow-sm)] transition hover:opacity-90"
      >
        حسابي
      </Link>
      <button
        type="button"
        onClick={() =>
          void logout().then(() => {
            router.replace("/");
          })
        }
        className="rounded-full border border-[var(--chip-border)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold text-[var(--text-muted)] shadow-[var(--shadow-sm)] transition hover:bg-[var(--chip)]"
      >
        تسجيل الخروج
      </button>
    </div>
  );
}
