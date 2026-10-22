"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/hooks/useAuth";
import { RequireAuthGate } from "@/components/auth/RequireAuthGate";
import { getBackendMe, syncBackendProfile } from "@/services/backendAuthService";
import { uploadBackendProfileAvatar } from "@/services/backendUploadService";
import { getAuthErrorMessage, sendPasswordResetLink } from "@/services/authService";
import { ModernAvatar } from "@/components/ui/ModernAvatar";
import { getAccountSettingsActionState } from "@/components/me/accountSettingsActions";
import { getResendVerificationState } from "@/components/auth/resendVerificationState";
import { NotificationPreferences } from "@/components/notifications/NotificationPreferences";

export function AccountSettingsForm() {
  const router = useRouter();
  const { currentUser, resendEmailVerification, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  /** يُحدَّث تلقائياً من السيرفر أو الرفع أو صورة جوجل — لا يُحرَّر يدوياً كحقل نص */
  const [photoURL, setPhotoURL] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [resetSending, setResetSending] = useState(false);
  const [verificationSending, setVerificationSending] = useState(false);
  const [verificationCooldown, setVerificationCooldown] = useState(0);

  const previewUrl = useMemo(() => {
    if (!avatarFile) return null;
    return URL.createObjectURL(avatarFile);
  }, [avatarFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const hasEmailPasswordProvider = Boolean(
    currentUser?.providerData?.some((p) => p.providerId === "password")
  );

  const hasGooglePhoto = Boolean(currentUser?.photoURL?.trim());
  const emailVerified = Boolean(currentUser?.emailVerified);
  const actionState = getAccountSettingsActionState({
    hasEmail: Boolean(currentUser?.email),
    hasEmailPasswordProvider,
    emailVerified,
  });
  const resendState = getResendVerificationState({
    sending: verificationSending,
    cooldownRemainingSeconds: verificationCooldown,
  });

  useEffect(() => {
    if (verificationCooldown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setVerificationCooldown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [verificationCooldown]);

  useEffect(() => {
    if (!currentUser) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    void getBackendMe()
      .then((profile) => {
        if (!mounted) return;
        setFullName(profile?.fullName || currentUser.displayName || "");
        setPhotoURL(profile?.photoURL || currentUser.photoURL || "");
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Failed to load profile.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [currentUser]);

  function applyGooglePhoto() {
    if (!currentUser?.photoURL) return;
    setPhotoURL(currentUser.photoURL);
    setAvatarFile(null);
    setSuccess(null);
    setError(null);
  }

  async function handleSendPasswordReset() {
    if (!currentUser?.email || !actionState.canSendPasswordReset) return;
    setResetSending(true);
    setError(null);
    setSuccess(null);
    try {
      await sendPasswordResetLink(currentUser.email);
      setSuccess("تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني.");
    } catch (err) {
      setError(getAuthErrorMessage(err));
    } finally {
      setResetSending(false);
    }
  }

  async function handleResendVerification() {
    if (!currentUser?.email || emailVerified || resendState.disabled) return;
    setVerificationSending(true);
    setError(null);
    setSuccess(null);
    try {
      await resendEmailVerification();
      setVerificationCooldown(60);
      setSuccess("تم إرسال رابط تأكيد البريد. افحص البريد الوارد أو البريد غير الهام.");
    } catch (err) {
      setError(getAuthErrorMessage(err));
    } finally {
      setVerificationSending(false);
    }
  }

  async function handleLogoutForSwitchAccount() {
    setError(null);
    try {
      await logout();
      router.replace("/login");
    } catch (err) {
      setError(getAuthErrorMessage(err));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fullName.trim()) {
      setError("الاسم الكامل مطلوب.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      let nextPhotoURL = photoURL.trim() || undefined;
      if (avatarFile) {
        setUploadingAvatar(true);
        const uploaded = await uploadBackendProfileAvatar(avatarFile);
        nextPhotoURL = uploaded.avatarUrl;
      }

      await syncBackendProfile({
        fullName: fullName.trim(),
        photoURL: nextPhotoURL,
      });
      if (nextPhotoURL) {
        setPhotoURL(nextPhotoURL);
      }
      setAvatarFile(null);
      setSuccess("تم تحديث بيانات الحساب بنجاح.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update profile.");
    } finally {
      setSaving(false);
      setUploadingAvatar(false);
    }
  }

  return (
    <RequireAuthGate fallbackMessage="يتم التحقق من الجلسة قبل إعدادات الحساب...">
      {loading ? (
        <p className="text-sm text-[var(--text-muted)]">جاري تحميل بيانات الحساب...</p>
      ) : (
        <div className="space-y-8">
          <form onSubmit={onSubmit} className="space-y-8">
            {error ? (
              <p className="motion-alert rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </p>
            ) : null}
            {success ? (
              <p className="motion-alert rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
                {success}
              </p>
            ) : null}

            {/* الملف الشخصي */}
            <section className="ui-card motion-section space-y-4 p-5 sm:p-6">
              <div className="border-b border-[var(--border)] pb-3">
                <h2 className="text-lg font-bold text-[var(--text)]">الملف الشخصي</h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  الاسم والصورة تظهر في إعلاناتك ومحادثاتك.
                </p>
              </div>

              <label className="space-y-1">
                <span className="text-sm font-medium">الاسم الكامل</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="ui-input w-full"
                  disabled={saving}
                  autoComplete="name"
                />
              </label>

              <div className="space-y-2">
                <span className="text-sm font-medium">الصورة الشخصية</span>
                <p className="text-xs text-[var(--text-muted)]">
                  ارفع صورة من جهازك — يتم حفظ الرابط تلقائياً على الخادم دون إدخال يدوي لرابط.
                </p>
                <input
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
                  className="ui-input w-full file:mr-2 file:rounded-full file:border-0 file:bg-[var(--chip)] file:px-3 file:py-1 file:text-xs file:font-semibold file:text-[var(--text-muted)]"
                  disabled={saving}
                />
                {hasGooglePhoto ? (
                  <button
                    type="button"
                    onClick={applyGooglePhoto}
                    disabled={saving}
                    className="text-xs font-semibold text-[var(--brand)] hover:underline disabled:opacity-50"
                  >
                    استخدام صورة حساب جوجل الحالية
                  </button>
                ) : null}
              </div>

              {(previewUrl || photoURL) && (
                <div className="motion-alert flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
                  <ModernAvatar src={previewUrl ?? photoURL} name={fullName || "المستخدم"} size="lg" />
                  <div>
                    <p className="text-sm font-medium text-[var(--text)]">
                      {previewUrl ? "معاينة قبل الحفظ" : "الصورة المحفوظة"}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {previewUrl ? "اضغط حفظ الإعدادات لتأكيد الرفع." : "ستُستخدم في بطاقة حسابك وإعلاناتك."}
                    </p>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={saving || uploadingAvatar}
                className="ui-btn-primary w-full sm:w-auto"
              >
                {saving || uploadingAvatar ? "جاري الحفظ..." : "حفظ الإعدادات"}
              </button>
            </section>
          </form>

          {/* الحساب */}
          <section className="ui-card motion-section space-y-4 p-5 sm:p-6">
            <div className="border-b border-[var(--border)] pb-3">
              <h2 className="text-lg font-bold text-[var(--text)]">الحساب</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">البريد مرتبط بتسجيل الدخول ولا يُغيَّر من هنا.</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
              <div>
                <p className="text-xs font-medium text-[var(--text-muted)]">البريد الإلكتروني</p>
                <p className="font-medium text-[var(--text)]">{currentUser?.email ?? "—"}</p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  emailVerified
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
                    : "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                }`}
              >
                {emailVerified ? "بريد مؤكد" : "بريد غير مؤكد"}
              </span>
            </div>
            {!emailVerified ? (
              <div className="motion-alert rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <p className="font-semibold">يلزم تأكيد البريد قبل استخدام كل مزايا الحساب.</p>
                <p className="mt-1 text-xs leading-6">
                  إذا لم يصلك الرابط، أعد الإرسال أو سجل الخروج لاستخدام بريد آخر.
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => void handleResendVerification()}
                    disabled={resendState.disabled}
                    className="rounded-full bg-amber-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-800 disabled:opacity-50"
                  >
                    {resendState.label}
                  </button>
                  <Link
                    href="/reset-password"
                    className="rounded-full border border-amber-300 bg-white px-4 py-2 text-center text-xs font-semibold text-amber-950 transition hover:bg-amber-100"
                  >
                    استعادة كلمة المرور
                  </Link>
                </div>
                {resendState.helpText ? (
                  <p className="mt-2 text-xs text-amber-900/80">{resendState.helpText}</p>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* الأمان */}
          <section className="ui-card motion-section space-y-4 p-5 sm:p-6">
            <div className="border-b border-[var(--border)] pb-3">
              <h2 className="text-lg font-bold text-[var(--text)]">الأمان</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                إدارة كلمة المرور عبر البريد الإلكتروني (Firebase).
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-[var(--text-muted)]">{actionState.passwordHelpText}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void handleSendPasswordReset()}
                  disabled={resetSending || !actionState.canSendPasswordReset}
                  className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--chip)] px-5 py-2 text-sm font-semibold text-[var(--text)] transition hover:border-[var(--brand)] hover:text-[var(--brand)] disabled:opacity-50"
                >
                  {resetSending ? "جاري الإرسال..." : "إرسال رابط تغيير كلمة المرور"}
                </button>
                <Link
                  href="/reset-password"
                  className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 py-2 text-center text-sm font-semibold text-[var(--text-muted)] transition hover:border-[var(--brand)] hover:text-[var(--brand)]"
                >
                  فتح صفحة الاستعادة
                </Link>
              </div>
            </div>
          </section>

          {/* إجراءات الحساب */}
          <section className="ui-card motion-section space-y-4 p-5 sm:p-6">
            <div className="border-b border-[var(--border)] pb-3">
              <h2 className="text-lg font-bold text-[var(--text)]">إجراءات الحساب</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                الخروج من هذا الجهاز أو استخدام حساب آخر.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleLogoutForSwitchAccount()}
              disabled={!actionState.showLogout}
              className="w-full rounded-full border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-semibold text-red-900 transition hover:bg-red-100 disabled:opacity-50 sm:w-auto"
            >
              تسجيل الخروج
            </button>
          </section>

          <NotificationPreferences />

          {/* روابط سريعة */}
          <section className="motion-section rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
            <h2 className="mb-3 text-sm font-bold text-[var(--text)]">اختصارات</h2>
            <div className="flex flex-wrap gap-2">
              <Link href="/my-listings" className="ui-chip px-4 py-2 text-xs font-semibold hover:border-[var(--brand)]">
                إعلاناتي
              </Link>
              <Link href="/favorites" className="ui-chip px-4 py-2 text-xs font-semibold hover:border-[var(--brand)]">
                المفضلة
              </Link>
              <Link href="/messages" className="ui-chip px-4 py-2 text-xs font-semibold hover:border-[var(--brand)]">
                الرسائل
              </Link>
              <Link href="/submit-listing" className="ui-chip px-4 py-2 text-xs font-semibold hover:border-[var(--brand)]">
                إضافة إعلان
              </Link>
            </div>
          </section>
        </div>
      )}
    </RequireAuthGate>
  );
}
