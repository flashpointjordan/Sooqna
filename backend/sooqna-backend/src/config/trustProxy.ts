export type TrustProxyValue = boolean | number | string;

export function parseTrustProxy(value: string | undefined): TrustProxyValue {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  return value.trim();
}

export function validateProductionTrustProxy(
  nodeEnv: string,
  trustProxy: TrustProxyValue
): void {
  if (nodeEnv === "production" && trustProxy === false) {
    throw new Error("TRUST_PROXY must be enabled in production behind Nginx.");
  }
}
