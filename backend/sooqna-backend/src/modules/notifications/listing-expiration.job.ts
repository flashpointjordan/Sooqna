import type { PrismaClient } from "@prisma/client";
import { enqueueNotificationEvent } from "./notifications.producer";

type JobDeps = { prisma: Pick<PrismaClient, "listing" | "$transaction">; now?: () => Date };

export async function runListingExpirationJob({ prisma, now = () => new Date() }: JobDeps): Promise<void> {
  const current = now();
  const warningEnd = new Date(current.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiring = await prisma.listing.findMany({ where: { status: "published", deletedAt: null, ownerId: { not: null }, expiresAt: { gt: current, lte: warningEnd } }, select: { id: true, ownerId: true, title: true, expiresAt: true } } as any);
  const day = current.toISOString().slice(0, 10);
  for (const listing of expiring as any[]) {
    if (!listing.ownerId || !listing.expiresAt) continue;
    await prisma.$transaction(async (tx: any) => {
      await enqueueNotificationEvent({ payload: { eventType: "LISTING_EXPIRING", recipientId: listing.ownerId, listingId: listing.id, listingTitle: listing.title, expiresAt: listing.expiresAt.toISOString() }, aggregateType: "listing", aggregateId: listing.id, recipientId: listing.ownerId, dedupeKey: `listing:${listing.id}:expiring:${day}` }, tx);
    });
  }

  const expired = await prisma.listing.findMany({ where: { status: "published", deletedAt: null, ownerId: { not: null }, expiresAt: { lte: current } }, select: { id: true, ownerId: true, title: true } } as any);
  for (const listing of expired as any[]) {
    if (!listing.ownerId) continue;
    await prisma.$transaction(async (tx: any) => {
      await tx.listing.update({ where: { id: listing.id }, data: { status: "archived", archivedAt: current, updatedAt: current } });
      await enqueueNotificationEvent({ payload: { eventType: "LISTING_EXPIRED", recipientId: listing.ownerId, listingId: listing.id, listingTitle: listing.title }, aggregateType: "listing", aggregateId: listing.id, recipientId: listing.ownerId, dedupeKey: `listing:${listing.id}:expired` }, tx);
    });
  }
}

export function startListingExpirationScheduler(deps: JobDeps, intervalMs = 6 * 60 * 60 * 1000): { stop: () => void } {
  let stopped = false;
  const timer = setInterval(() => { if (!stopped) void runListingExpirationJob(deps).catch(() => undefined); }, intervalMs);
  timer.unref?.();
  void runListingExpirationJob(deps).catch(() => undefined);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
