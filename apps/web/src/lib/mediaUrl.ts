/**
 * Listing uploads may store absolute URLs from dev (`http://localhost:5000/uploads/...`).
 * On production HTTPS, those cause Mixed Content and hit the user's machine. Rewrite to the
 * public uploads origin using NEXT_PUBLIC_* (same origin convention as the deployed API).
 */

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Base URL for `/uploads` as the browser should request it (HTTPS in prod). */
export function getPublicUploadsBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_UPLOADS_PUBLIC_BASE_URL?.trim();
  if (explicit) return trimTrailingSlash(explicit);
  const api = process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL?.trim() ?? "";
  if (api.endsWith("/api")) {
    return trimTrailingSlash(api.slice(0, -4) + "/uploads");
  }
  return "";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Rewrite loopback and legacy Sooqna uploads to the configured public origin.
 * Relative URLs and unrelated public hosts are returned unchanged.
 */
export function resolvePublicMediaUrl(url: string | undefined | null): string | undefined {
  if (url == null || url === "") return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  const publicBase = getPublicUploadsBaseUrl();
  if (!publicBase) return trimmed;

  try {
    const parsed = new URL(trimmed);
    const legacyUpload = parsed.hostname === "un.flashpointjordan.com" && parsed.pathname.startsWith("/uploads/");
    if (!isLoopbackHost(parsed.hostname) && !legacyUpload) return trimmed;

    const base = new URL(publicBase.includes("://") ? publicBase : `https://${publicBase}`);
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return trimmed;
  }
}
