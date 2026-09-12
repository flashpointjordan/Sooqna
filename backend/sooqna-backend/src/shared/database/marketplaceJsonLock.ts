import * as path from "node:path";
import { withFileLock } from "./fileLock";

const marketplaceJsonLockPath = path.resolve(
  process.cwd(),
  "src/shared/database/marketplace-json-state.lock"
);

/**
 * Serializes every JSON-fallback write that can touch listings. Cross-store
 * mutations use this one lock instead of nesting per-file locks, so lock order
 * cannot invert and the listing counter is computed from the same favorite state.
 */
export function withMarketplaceJsonLock<T>(work: () => Promise<T> | T): Promise<T> {
  return withFileLock(marketplaceJsonLockPath, async () => work());
}
