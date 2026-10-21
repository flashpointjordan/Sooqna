import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { ThemeSwitcher } from "@/components/layout/ThemeSwitcher";
import { PublicNavActions } from "@/components/layout/PublicNavActions";
import { SearchBar } from "@/components/layout/SearchBar";
import { ScrollToTopButton } from "@/components/layout/ScrollToTopButton";
import { BottomNav } from "@/components/layout/BottomNav";
import { AdminNavLink } from "@/components/layout/AdminNavLink";
import { NotificationBell } from "@/components/notifications/NotificationBell";

export function PublicShell({
  children,
  pageTitle,
  pageDescription,
}: {
  children: ReactNode;
  pageTitle?: string;
  pageDescription?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30">
        <div className="border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="relative mx-auto flex max-w-[1110px] items-center justify-center px-4 py-2.5 sm:px-6 md:justify-between">
            {/* ThemeSwitcher: absolute on physical left on mobile */}
            <div className="absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-2 md:hidden">
              <ThemeSwitcher />
              <NotificationBell />
            </div>

            <Link href="/" className="flex items-center gap-3">
              <Image
                src="/branding/logo-transparent.png"
                alt="سوقنا"
                width={160}
                height={72}
                className="h-16 w-auto"
                priority
              />
            </Link>

            <div className="hidden items-center gap-2 md:flex">
              <ThemeSwitcher />
              <PublicNavActions />
            </div>
          </div>
        </div>

        <div className="border-b border-[var(--accent-strip)] bg-[var(--accent-strip)]">
          <div className="mx-auto flex max-w-[1110px] items-center gap-3 px-4 py-2 sm:px-6">
            <Link
              href="/submit-listing"
              className="ui-btn-primary rounded-full px-5"
            >
              + أعلن
            </Link>

            <Suspense>
              <SearchBar />
            </Suspense>

            <AdminNavLink />
          </div>
        </div>

      </header>

      <main className="mx-auto flex w-full max-w-[1110px] flex-1 flex-col px-4 py-7 pb-20 sm:px-6 md:pb-6">
        {pageTitle ? (
          <section className="mb-6">
              <h1 className="text-4xl font-extrabold tracking-tight text-[var(--text)] sm:text-5xl" style={{ lineHeight: 1.25 }}>
              {pageTitle}
            </h1>
            {pageDescription ? (
              <p className="mt-2 max-w-3xl text-sm leading-7 text-[var(--text-muted)]">{pageDescription}</p>
            ) : null}
          </section>
        ) : null}
        {children}
      </main>

      <BottomNav />

      <footer className="border-t border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto max-w-[1110px] px-3 py-6 sm:px-6 sm:py-10">
          {/* Mobile footer layout */}
          <div className="md:hidden">
            <div className="grid grid-cols-3 gap-x-3 gap-y-6">
              <FooterColumn className="text-center" title="عن سوقنا" items={[{ label: "من نحن", href: "/about" }, { label: "الوظائف", href: "/careers" }, { label: "المركز الإعلامي", href: "/press" }, { label: "التطبيقات", href: "/packages" }, { label: "اتصل بنا", href: "/contact" }]} />
              <FooterColumn className="text-center" title="معلومات" items={[{ label: "المساعدة", href: "/help" }, { label: "نصائح الأمان", href: "/safety" }, { label: "سياسة الخصوصية", href: "/privacy" }, { label: "شروط الاستخدام", href: "/terms" }]} />
              <FooterColumn className="text-center" title="للشركات" items={[{ label: "الإعلان معنا", href: "/contact" }, { label: "الباقات الإعلانية", href: "/packages" }, { label: "حلول الشركات", href: "/contact" }]} />
            </div>
            <div className="mx-auto mt-6 grid max-w-xs grid-cols-2 gap-x-3">
              <FooterColumn className="text-center" title="عام" items={[{ label: "عمليات البحث الشائعة", href: "/listings" }, { label: "عرض التصنيفات", href: "/categories" }, { label: "إضافة إعلان", href: "/submit-listing" }]} />
              <div className="text-center">
                <h3 className="mb-2 text-[11px] font-bold">التواصل الاجتماعي</h3>
                <div className="flex items-center justify-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">f</span>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">in</span>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">▶</span>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">◎</span>
                </div>
              </div>
            </div>
          </div>

          {/* Desktop footer layout */}
          <div className="hidden gap-8 md:grid md:grid-cols-5">
            <FooterColumn title="عن سوقنا" items={[{ label: "من نحن", href: "/about" }, { label: "الوظائف", href: "/careers" }, { label: "المركز الإعلامي", href: "/press" }, { label: "التطبيقات", href: "/packages" }, { label: "اتصل بنا", href: "/contact" }]} />
            <FooterColumn title="معلومات" items={[{ label: "المساعدة", href: "/help" }, { label: "نصائح الأمان", href: "/safety" }, { label: "سياسة الخصوصية", href: "/privacy" }, { label: "شروط الاستخدام", href: "/terms" }]} />
            <FooterColumn title="للشركات" items={[{ label: "الإعلان معنا", href: "/contact" }, { label: "الباقات الإعلانية", href: "/packages" }, { label: "حلول الشركات", href: "/contact" }]} />
            <FooterColumn title="عام" items={[{ label: "عمليات البحث الشائعة", href: "/listings" }, { label: "عرض التصنيفات", href: "/categories" }, { label: "إضافة إعلان", href: "/submit-listing" }]} />
            <div>
              <h3 className="mb-4 text-base font-bold">التواصل الاجتماعي</h3>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">f</span>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">in</span>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">▶</span>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--chip-border)] bg-[var(--surface-muted)] text-xs shadow-[var(--shadow-sm)]">◎</span>
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-[var(--border)] pt-5">
            <p className="mb-3 text-sm font-semibold">التصنيفات</p>
            <div className="flex flex-wrap gap-2">
              {["أخرى", "وظائف", "عقارات", "سيارات", "موبايلات", "أثاث", "مستلزمات الأطفال"].map(
                (chip) => (
                  <span
                    key={chip}
                    className="ui-chip px-4 py-1.5"
                  >
                    {chip}
                  </span>
                )
              )}
            </div>
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
            <p>جميع الحقوق محفوظة © 2026 سوقنا</p>
            <ScrollToTopButton />
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, items, className }: { title: string; items: { label: string; href: string }[]; className?: string }) {
  return (
    <div className={className}>
      <h3 className="mb-2 text-[11px] font-bold md:mb-4 md:text-base">{title}</h3>
      <ul className="space-y-1.5 md:space-y-2">
        {items.map((item) => (
          <li key={item.label}>
            <Link href={item.href} className="text-[10px] leading-tight text-[var(--text-muted)] hover:text-[var(--brand)] md:text-sm">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

