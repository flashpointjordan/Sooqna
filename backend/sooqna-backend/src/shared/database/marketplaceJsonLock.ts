import { withFileLock } from "./fileLock";
import { jsonFallbackRuntimePath } from "./jsonFallbackRuntime";

const marketplaceJsonLockPath = jsonFallbackRuntimePath("marketplace-json-state.lock");

/**
 * Serializes every JSON-fallback write that can touch shared marketplace state.
 * Cross-store mutations and journal recovery use this one lock instead of
 * nesting per-file locks, so recovery cannot race API or worker mutations.
 */
export function withMarketplaceJsonLock<T>(work: () => Promise<T> | T): Promise<T> {
  return withFileLock(marketplaceJsonLockPath, async () => work());
}
