const order: string[] = [];
const mockRecoverMarketplace = jest.fn(() => { order.push("messages-journals"); });
const mockRecoverLifecycle = jest.fn(async () => { order.push("listing-lifecycle"); return 0; });
const mockWithLock = jest.fn(async (work: () => Promise<void>) => {
  order.push("lock-acquired");
  await work();
});

jest.mock("../../config/env", () => ({
  env: { enableCategoriesJsonFallback: true, databaseUrl: "" },
}));
jest.mock("./marketplaceJsonLock", () => ({
  withMarketplaceJsonLock: (work: () => Promise<void>) => mockWithLock(work),
}));
jest.mock("./marketplaceJsonRecovery", () => ({
  recoverMarketplaceJsonJournalsUnlocked: () => mockRecoverMarketplace(),
}));
jest.mock("../../modules/notifications/listingNotificationProducers", () => ({
  recoverJsonListingLifecycleJournalUnlocked: () => mockRecoverLifecycle(),
}));

import { recoverJsonFallbackRuntimeState } from "./jsonFallbackStartupRecovery";

test("recovers every messages-state journal in one marketplace lock", async () => {
  await recoverJsonFallbackRuntimeState();

  expect(order).toEqual(["lock-acquired", "messages-journals", "listing-lifecycle"]);
  expect(mockWithLock).toHaveBeenCalledTimes(1);
});
