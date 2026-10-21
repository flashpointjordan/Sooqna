import { NotificationType } from "@prisma/client";
import { enqueueNotificationEvent } from "./notifications.producer";

export type BroadcastUser = { firebaseUid: string; role: string };
export type BroadcastStore = {
  findUsers(args: { after: string | null; take: number; audience?: "ALL" | "ROLES" | "USERS"; roles?: string[]; userIds?: string[] }): Promise<BroadcastUser[]>;
  enqueue(user: BroadcastUser, payload?: Record<string, unknown>): Promise<void>;
  saveProgress(cursor: string | null): Promise<void>;
  complete(): Promise<void>;
};
export type BroadcastFacts = { id: string; audience: "ALL" | "ROLES" | "USERS"; cursor: string | null; roles?: string[]; userIds?: string[]; title?: string; body?: string; actionUrl?: string | null };

export async function fanOutBroadcastBatch(store: BroadcastStore, facts: BroadcastFacts): Promise<{ processed: number; cursor: string | null; completed: boolean }> {
  const users = await store.findUsers({ after: facts.cursor, take: 200, audience: facts.audience, roles: facts.roles, userIds: facts.userIds });
  for (const user of users) {
    const payload = { eventType: NotificationType.SYSTEM_ANNOUNCEMENT, recipientId: user.firebaseUid, announcementId: facts.id, title: facts.title ?? "", body: facts.body ?? "", actionUrl: facts.actionUrl ?? null };
    await store.enqueue(user, payload);
  }
  const cursor = users.length ? users[users.length - 1].firebaseUid : facts.cursor;
  await store.saveProgress(cursor);
  const completed = users.length < 200;
  if (completed) await store.complete();
  return { processed: users.length, cursor, completed };
}

export function createPrismaBroadcastStore(prisma: any, facts: BroadcastFacts): BroadcastStore {
  return {
    findUsers: async ({ after, take, audience, roles, userIds }) => prisma.user.findMany({ where: { firebaseUid: after ? { gt: after } : undefined, ...(audience === "ROLES" ? { role: { in: roles } } : {}), ...(audience === "USERS" ? { firebaseUid: { in: userIds } } : {}) }, orderBy: { firebaseUid: "asc" }, take, select: { firebaseUid: true, role: true } }),
    enqueue: async (_user, payload) => { if (!payload) return; await enqueueNotificationEvent({ payload: payload as any, aggregateType: "broadcast", aggregateId: facts.id, recipientId: String(payload.recipientId), dedupeKey: `broadcast:${facts.id}:${String(payload.recipientId)}` }); },
    saveProgress: async (cursor) => { await prisma.notificationBroadcast.update({ where: { id: facts.id }, data: { cursor } }); },
    complete: async () => { await prisma.notificationBroadcast.update({ where: { id: facts.id }, data: { status: "COMPLETED" } }); },
  };
}

export async function processPendingBroadcasts(prisma: any): Promise<void> {
  const row = await prisma.notificationBroadcast.findFirst({ where: { status: { in: ["PENDING", "PROCESSING"] } }, orderBy: { createdAt: "asc" } });
  if (!row) return;
  await prisma.notificationBroadcast.update({ where: { id: row.id }, data: { status: "PROCESSING" } });
  const audience = row.audienceValue as { roles?: string[]; userIds?: string[] };
  await fanOutBroadcastBatch(createPrismaBroadcastStore(prisma, { id: row.id, audience: row.audience, cursor: row.cursor, roles: audience.roles, userIds: audience.userIds, title: row.title, body: row.body, actionUrl: row.actionUrl }), { id: row.id, audience: row.audience, cursor: row.cursor, roles: audience.roles, userIds: audience.userIds, title: row.title, body: row.body, actionUrl: row.actionUrl });
}
