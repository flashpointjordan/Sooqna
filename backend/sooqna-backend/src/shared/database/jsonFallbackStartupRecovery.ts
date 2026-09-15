import { env } from "../../config/env";
import { recoverJsonListingLifecycleJournalUnlocked } from "../../modules/notifications/listingNotificationProducers";
import { withMarketplaceJsonLock } from "./marketplaceJsonLock";
import { recoverMarketplaceJsonJournalsUnlocked } from "./marketplaceJsonRecovery";

export async function recoverJsonFallbackRuntimeState(now = new Date()): Promise<void> {
  if (!env.enableCategoriesJsonFallback || env.databaseUrl) return;
  await withMarketplaceJsonLock(async () => {
    recoverMarketplaceJsonJournalsUnlocked();
    await recoverJsonListingLifecycleJournalUnlocked(now);
  });
}
