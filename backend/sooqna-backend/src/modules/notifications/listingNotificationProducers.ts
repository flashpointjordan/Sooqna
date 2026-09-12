import type { Prisma, PrismaClient } from "@prisma/client";
import * as path from "node:path";
import { AppError } from "../../shared/errors/appError";
import { withMarketplaceJsonLock } from "../../shared/database/marketplaceJsonLock";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../utils/fileStore";
import {
  readJsonMessageFallbackStateUnlocked,
  writeJsonMessageFallbackStateUnlocked,
  type JsonMessagesState,
} from "../messages/repositories/messages.repository";
import { enqueueNotificationEvent, type EnqueueNotificationEventInput } from "./notifications.producer";

export type ModerationAction = "publish" | "reject" | "archive" | "sold" | "feature" | "unfeature";
type ListingIdentity = { id: string; ownerId: string | null; title: string };
type LifecycleListing = ListingIdentity & { status: string; expiresAt: Date | null };
type LifecycleClient = Pick<PrismaClient, "$transaction"> & {
  listing: {
    findMany(args: unknown): Promise<LifecycleListing[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  notificationOutbox: Prisma.TransactionClient["notificationOutbox"];
};

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export function parseRejectionReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "Rejection reason is required.", "VALIDATION_ERROR");
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  if (!cleaned) throw new AppError(400, "Rejection reason is required.", "VALIDATION_ERROR");
  if (Array.from(cleaned).length > 500) {
    throw new AppError(400, "Rejection reason must not exceed 500 characters.", "VALIDATION_ERROR");
  }
  return cleaned;
}

export function moderationNotification(
  action: ModerationAction,
  listing: ListingIdentity,
  occurredAt: Date,
  rejectionReason?: unknown
): EnqueueNotificationEventInput | null {
  if (!listing.ownerId) return null;
  const timestamp = occurredAt.toISOString();
  if (action === "publish") {
    return {
      aggregateType: "listing",
      aggregateId: listing.id,
      recipientId: listing.ownerId,
      dedupeKey: `listing-approved:${listing.id}:${timestamp}`,
      payload: {
        eventType: "LISTING_APPROVED",
        recipientId: listing.ownerId,
        listingId: listing.id,
        listingTitle: listing.title,
      },
    };
  }
  if (action === "reject") {
    return {
      aggregateType: "listing",
      aggregateId: listing.id,
      recipientId: listing.ownerId,
      dedupeKey: `listing-rejected:${listing.id}:${timestamp}`,
      payload: {
        eventType: "LISTING_REJECTED",
        recipientId: listing.ownerId,
        listingId: listing.id,
        listingTitle: listing.title,
        rejectionReason: parseRejectionReason(rejectionReason),
      },
    };
  }
  return null;
}

export async function enqueueModerationNotification(
  action: ModerationAction,
  listing: ListingIdentity,
  occurredAt: Date,
  rejectionReason: string | undefined,
  tx: Prisma.TransactionClient
): Promise<void> {
  const event = moderationNotification(action, listing, occurredAt, rejectionReason);
  if (event) await enqueueNotificationEvent(event, tx);
}

export async function runListingLifecycle(
  client: LifecycleClient,
  now = new Date(),
  options: { pageSize?: number; warningDays?: number } = {}
): Promise<{ expiring: number; expired: number }> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 100, 200));
  const warningDays = Math.max(1, Math.min(options.warningDays ?? 3, 30));
  const warningEnd = new Date(now.getTime() + warningDays * 86_400_000);
  const utcDay = now.toISOString().slice(0, 10);
  let cursor: string | undefined;
  let expiring = 0;
  let expired = 0;

  for (;;) {
    const page = await client.listing.findMany({
      where: {
        deletedAt: null,
        status: "published",
        ownerId: { not: null },
        expiresAt: { not: null, lte: warningEnd },
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, ownerId: true, title: true, status: true, expiresAt: true },
    });
    for (const listing of page) {
      if (!listing.ownerId || !listing.expiresAt) continue;
      if (listing.expiresAt <= now) {
        const transitioned = await client.$transaction(async (tx) => {
          const result = await tx.listing.updateMany({
            where: { id: listing.id, status: "published", deletedAt: null, expiresAt: { lte: now } },
            data: { status: "archived", isFeatured: false, archivedAt: now, updatedAt: now },
          });
          if (result.count !== 1) return false;
          await enqueueNotificationEvent({
            aggregateType: "listing",
            aggregateId: listing.id,
            recipientId: listing.ownerId!,
            dedupeKey: `listing-expired:${listing.id}:${listing.expiresAt!.toISOString()}`,
            payload: {
              eventType: "LISTING_EXPIRED",
              recipientId: listing.ownerId!,
              listingId: listing.id,
              listingTitle: listing.title,
            },
          }, tx as Prisma.TransactionClient);
          return true;
        });
        if (transitioned) expired += 1;
      } else {
        await enqueueNotificationEvent({
          aggregateType: "listing",
          aggregateId: listing.id,
          recipientId: listing.ownerId,
          dedupeKey: `listing-expiring:${listing.id}:${utcDay}`,
          payload: {
            eventType: "LISTING_EXPIRING",
            recipientId: listing.ownerId,
            listingId: listing.id,
            listingTitle: listing.title,
            expiresAt: listing.expiresAt.toISOString(),
          },
        }, client as unknown as Prisma.TransactionClient);
        expiring += 1;
      }
    }
    if (page.length < pageSize) break;
    cursor = page.at(-1)?.id;
    if (!cursor) break;
  }
  return { expiring, expired };
}

export type JsonLifecycleListing = {
  id: string;
  ownerId: string | null;
  title: string;
  status: string;
  expiresAt: string | null;
  isFeatured: boolean;
  archivedAt: string | null;
  updatedAt: string;
  locationCity?: string;
  [key: string]: unknown;
};
type JsonLifecycleState = {
  listings: JsonLifecycleListing[];
  notificationOutbox: Array<Record<string, unknown>>;
};

function enqueueJsonLifecycleEvent(
  state: JsonLifecycleState,
  input: EnqueueNotificationEventInput,
  now: Date
): boolean {
  if (state.notificationOutbox.some((row) => row.dedupeKey === input.dedupeKey)) return false;
  state.notificationOutbox.push({
    id: `outbox_${input.dedupeKey}`,
    eventType: input.payload.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    recipientId: input.recipientId ?? null,
    payload: input.payload,
    dedupeKey: input.dedupeKey,
    state: "PENDING",
    attempts: 0,
    availableAt: now.toISOString(),
    notificationAppliedAt: null,
    processedAt: null,
    lastError: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return true;
}

/** Applies the same expiry transitions and deterministic events in fallback storage. */
export function runJsonListingLifecycleState(
  state: JsonLifecycleState,
  now = new Date(),
  options: { warningDays?: number } = {}
): { expiring: number; expired: number } {
  const warningDays = Math.max(1, Math.min(options.warningDays ?? 3, 30));
  const warningEnd = new Date(now.getTime() + warningDays * 86_400_000);
  const utcDay = now.toISOString().slice(0, 10);
  let expiring = 0;
  let expired = 0;
  for (const listing of state.listings) {
    if (listing.status !== "published" || !listing.ownerId || !listing.expiresAt) continue;
    const expiresAt = new Date(listing.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt > warningEnd) continue;
    if (expiresAt <= now) {
      enqueueJsonLifecycleEvent(state, {
        aggregateType: "listing",
        aggregateId: listing.id,
        recipientId: listing.ownerId,
        dedupeKey: `listing-expired:${listing.id}:${expiresAt.toISOString()}`,
        payload: { eventType: "LISTING_EXPIRED", recipientId: listing.ownerId, listingId: listing.id, listingTitle: listing.title },
      }, now);
      listing.status = "archived";
      listing.isFeatured = false;
      listing.archivedAt = now.toISOString();
      listing.updatedAt = now.toISOString();
      expired += 1;
      continue;
    }
    if (enqueueJsonLifecycleEvent(state, {
      aggregateType: "listing",
      aggregateId: listing.id,
      recipientId: listing.ownerId,
      dedupeKey: `listing-expiring:${listing.id}:${utcDay}`,
      payload: { eventType: "LISTING_EXPIRING", recipientId: listing.ownerId, listingId: listing.id, listingTitle: listing.title, expiresAt: expiresAt.toISOString() },
    }, now)) expiring += 1;
  }
  return { expiring, expired };
}

const fallbackListingsPath = path.resolve(process.cwd(), "src/modules/listings/repositories/listings.data.json");
const fallbackLifecycleJournalPath = path.resolve(process.cwd(), "src/modules/notifications/listing-lifecycle.journal.json");

type JsonExpiryTransition = {
  listingId: string;
  ownerId: string;
  listingTitle: string;
  expiresAt: string;
};
export type JsonLifecycleJournal = { createdAt: string; transitions: JsonExpiryTransition[] };

export type JsonLifecycleStorage = {
  withLock<T>(work: () => Promise<T> | T): Promise<T>;
  readListings(): JsonLifecycleListing[];
  writeListings(listings: JsonLifecycleListing[]): void;
  readMessageState(): JsonMessagesState;
  writeMessageState(state: JsonMessagesState): void;
  readJournal(): JsonLifecycleJournal | null;
  writeJournal(journal: JsonLifecycleJournal | null): void;
  afterEventsPersisted?(): Promise<void> | void;
};

const jsonLifecycleFileStorage: JsonLifecycleStorage = {
  withLock: withMarketplaceJsonLock,
  readListings: () => readJsonArrayFile<JsonLifecycleListing>(fallbackListingsPath),
  writeListings: (listings) => writeJsonArrayFileAtomically(fallbackListingsPath, listings),
  readMessageState: readJsonMessageFallbackStateUnlocked,
  writeMessageState: writeJsonMessageFallbackStateUnlocked,
  readJournal: () => readJsonArrayFile<JsonLifecycleJournal>(fallbackLifecycleJournalPath)[0] ?? null,
  writeJournal: (journal) => writeJsonArrayFileAtomically(fallbackLifecycleJournalPath, journal ? [journal] : []),
};

function expiredEvent(transition: JsonExpiryTransition): EnqueueNotificationEventInput {
  return {
    aggregateType: "listing",
    aggregateId: transition.listingId,
    recipientId: transition.ownerId,
    dedupeKey: `listing-expired:${transition.listingId}:${transition.expiresAt}`,
    payload: {
      eventType: "LISTING_EXPIRED",
      recipientId: transition.ownerId,
      listingId: transition.listingId,
      listingTitle: transition.listingTitle,
    },
  };
}

async function applyJsonLifecycleJournal(
  journal: JsonLifecycleJournal,
  now: Date,
  storage: JsonLifecycleStorage
): Promise<number> {
  const messageState = storage.readMessageState();
  let outboxChanged = false;
  for (const transition of journal.transitions) {
    outboxChanged = enqueueJsonLifecycleEvent(
      { listings: [], notificationOutbox: messageState.notificationOutbox },
      expiredEvent(transition),
      new Date(journal.createdAt)
    ) || outboxChanged;
  }
  if (outboxChanged) storage.writeMessageState(messageState);
  await storage.afterEventsPersisted?.();

  // Re-read after the durable event write. A previous crash may have released
  // the lock and allowed a legitimate marketplace update before this retry.
  const listings = storage.readListings();
  let transitioned = 0;
  for (const transition of journal.transitions) {
    const listing = listings.find((item) => item.id === transition.listingId);
    if (!listing || listing.status !== "published" || listing.expiresAt !== transition.expiresAt) continue;
    listing.status = "archived";
    listing.isFeatured = false;
    listing.archivedAt = now.toISOString();
    listing.updatedAt = now.toISOString();
    transitioned += 1;
  }
  if (transitioned > 0) storage.writeListings(listings);
  storage.writeJournal(null);
  return transitioned;
}

export function runJsonListingLifecycle(
  now = new Date(),
  storage: JsonLifecycleStorage = jsonLifecycleFileStorage
): Promise<{ expiring: number; expired: number }> {
  return storage.withLock(async () => {
    let expired = 0;
    const pending = storage.readJournal();
    if (pending) expired += await applyJsonLifecycleJournal(pending, now, storage);

    const listings = storage.readListings();
    const transitions = listings.flatMap((listing): JsonExpiryTransition[] => {
      if (listing.status !== "published" || !listing.ownerId || !listing.expiresAt) return [];
      const expiresAt = new Date(listing.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt > now) return [];
      return [{ listingId: listing.id, ownerId: listing.ownerId, listingTitle: listing.title, expiresAt: expiresAt.toISOString() }];
    });
    if (transitions.length > 0) {
      const journal = { createdAt: now.toISOString(), transitions };
      storage.writeJournal(journal);
      expired += await applyJsonLifecycleJournal(journal, now, storage);
    }

    const latestListings = storage.readListings();
    const messageState = storage.readMessageState();
    const before = messageState.notificationOutbox.length;
    const result = runJsonListingLifecycleState(
      { listings: latestListings.filter((listing) => listing.expiresAt && new Date(listing.expiresAt) > now), notificationOutbox: messageState.notificationOutbox },
      now
    );
    if (messageState.notificationOutbox.length !== before) storage.writeMessageState(messageState);
    return { expiring: result.expiring, expired };
  });
}
