export type CleanupStore = {
  findNotificationIds(now: Date, take: number): Promise<string[]>;
  deleteNotifications(ids: string[]): Promise<number>;
  deleteProcessedOutbox(cutoff: Date): Promise<number>;
  deleteDeadOutbox(cutoff: Date): Promise<number>;
};
let lastCleanupTotals = { notifications: 0, processedOutbox: 0, deadOutbox: 0 };
export function getCleanupTotals() { return { ...lastCleanupTotals }; }
export async function cleanupNotifications(store: CleanupStore, now = new Date()): Promise<{ notifications: number; processedOutbox: number; deadOutbox: number }> {
  let notifications = 0;
  while (true) {
    const ids = await store.findNotificationIds(now, 500);
    if (!ids.length) break;
    notifications += await store.deleteNotifications(ids);
    if (ids.length < 500) break;
  }
  const processedOutbox = await store.deleteProcessedOutbox(new Date(now.getTime() - 14 * 86400000));
  const deadOutbox = await store.deleteDeadOutbox(new Date(now.getTime() - 30 * 86400000));
  lastCleanupTotals = { notifications, processedOutbox, deadOutbox };
  return lastCleanupTotals;
}
