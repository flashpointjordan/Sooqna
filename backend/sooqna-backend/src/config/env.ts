import * as dotenv from "dotenv";
import { parseTrustProxy, validateProductionTrustProxy } from "./trustProxy";

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

function requireInProduction(value: string | undefined, name: string): string {
  if (!value && isProduction) {
    throw new Error(`Environment variable ${name} is required in production.`);
  }
  return value ?? "";
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  const normalized = Math.trunc(parsed);
  if (normalized < min || normalized > max) return defaultValue;
  return normalized;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const enableCategoriesJsonFallback = parseBoolean(
  process.env.ENABLE_CATEGORIES_JSON_FALLBACK,
  false
);
const databaseUrl = process.env.DATABASE_URL ?? "";
const requireDatabase = isProduction || !enableCategoriesJsonFallback;
// Browsers send the `Origin` header without a trailing slash and without a path
// (scheme://host[:port] only). Normalize configured origins the same way so an
// allowlist entry written as "https://site.com/" still matches "https://site.com".
const corsOrigins = parseCsv(
  process.env.CORS_ORIGIN ?? (isProduction ? undefined : "http://localhost:3000")
).map((origin) => origin.replace(/\/+$/, ""));
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

validateProductionTrustProxy(nodeEnv, trustProxy);

if (!databaseUrl && requireDatabase) {
  throw new Error(
    "DATABASE_URL is required. Provide a PostgreSQL connection string or explicitly enable ENABLE_CATEGORIES_JSON_FALLBACK=true for local fallback-only mode."
  );
}

/**
 * Public base URL for `/uploads/*` as seen by browsers (HTTPS in production).
 * Prefer explicit UPLOADS_PUBLIC_BASE_URL; otherwise derive from BACKEND_PUBLIC_ORIGIN (same host as API, without `/api`).
 */
function resolveUploadsPublicBaseUrl(): string {
  const explicit = process.env.UPLOADS_PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const origin = process.env.BACKEND_PUBLIC_ORIGIN?.trim();
  if (origin) return `${origin.replace(/\/$/, "")}/uploads`;
  if (isProduction) {
    throw new Error("UPLOADS_PUBLIC_BASE_URL or BACKEND_PUBLIC_ORIGIN is required in production.");
  }
  return "http://localhost:5000/uploads";
}

export const env = {
  port: Number(process.env.PORT ?? 5000),
  nodeEnv,
  corsOrigin: corsOrigins[0] ?? (isProduction
    ? (() => { throw new Error("CORS_ORIGIN env var is required in production."); })()
    : "http://localhost:3000"),
  corsOrigins,
  trustProxy,
  /**
   * Emails that should always be promoted to the ADMIN role on login/profile
   * sync. Used to bootstrap the first admin (no UI exists for the first one).
   * Comma-separated, case-insensitive.
   */
  adminEmails: parseCsv(process.env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
  uploadsPublicBaseUrl: resolveUploadsPublicBaseUrl(),
  firebaseProjectId: requireInProduction(process.env.FIREBASE_PROJECT_ID, "FIREBASE_PROJECT_ID"),
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? "",
  firebasePrivateKey: (process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "",
  firebaseUseApplicationDefaultCredentials: parseBoolean(
    process.env.FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS,
    false
  ),
  recaptchaEnabled: parseBoolean(process.env.RECAPTCHA_ENABLED, isProduction),
  recaptchaSecretKey: process.env.RECAPTCHA_SECRET_KEY ?? "",
  requireEmailVerified: parseBoolean(process.env.REQUIRE_EMAIL_VERIFIED, isProduction),
  moderationBlockedKeywords: parseCsv(process.env.MODERATION_BLOCKED_KEYWORDS).map((item) =>
    item.toLowerCase()
  ),
  listingDefaultExpiryDays: parsePositiveInt(process.env.LISTING_DEFAULT_EXPIRY_DAYS, 30, 1, 365),
  listingRenewDays: parsePositiveInt(process.env.LISTING_RENEW_DAYS, 30, 1, 365),
  databaseUrl,
  enableCategoriesJsonFallback,
  /** نموذج اتصل بنا — إرسال عبر Resend */
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  contactToEmail: process.env.CONTACT_TO_EMAIL ?? "info@sooqna.com",
  contactFromEmail: process.env.CONTACT_FROM_EMAIL ?? "onboarding@resend.dev",
};

if (isProduction && env.recaptchaEnabled && !env.recaptchaSecretKey) {
  throw new Error("RECAPTCHA_SECRET_KEY is required in production when RECAPTCHA_ENABLED=true.");
}

