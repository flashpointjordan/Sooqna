const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null = null,
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function parseRetryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

export function isRetryableRequestError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof ApiRequestError)) return false;
  if (error.code === "REQUEST_TIMEOUT") return true;
  return error.status !== null && RETRYABLE_HTTP_STATUSES.has(error.status);
}
