import { NotificationOutboxState, NotificationType } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import { projectNotificationEventPayload } from "./notifications.producer";
import type { NotificationEventPayload } from "./notifications.types";

export type NotificationOutboxRecord = {
  id: string; eventType: NotificationType; aggregateType: string; aggregateId: string; recipientId: string | null;
  payload: unknown; dedupeKey: string; state: NotificationOutboxState; attempts: number; availableAt: Date;
  processedAt: Date | null; lastError: string | null; createdAt: Date; updatedAt: Date;
  claimAttempt: number;
};

export type NotificationOutboxRepository = {
  recoverStaleProcessing(now: Date, staleBefore: Date): Promise<{ recovered: number; dead: Array<{ id: string; attempts: number }> }>;
  claimReady(limit: number, now: Date): Promise<NotificationOutboxRecord[]>;
  markProcessed(id: string, claimAttempt: number, now: Date): Promise<boolean>;
  markFailure(id: string, claimAttempt: number, error: string, availableAt: Date, now: Date): Promise<NotificationOutboxState>;
};

export type NotificationWorkerService = {
  persistFromEvent?: (type: NotificationType, payload: NotificationEventPayload, options: { dedupeKey: string; aggregationKey?: string }) => Promise<{ row: { id: string; userId: string } | null; changed: boolean }>;
  unreadCount?: (userId: string) => Promise<number>;
  signalPersisted?: (userId: string, notificationId: string, unreadCount?: number) => Promise<void>;
};

type WorkerDeps = {
  repository: NotificationOutboxRepository;
  service: NotificationWorkerService;
  batchSize?: number;
  intervalMs?: number;
  now?: () => Date;
  jitter?: () => number;
  logger?: { error(message: string, meta?: Record<string, unknown>): void; warn?(message: string, meta?: Record<string, unknown>): void };
  publishSignal?: (userId: string, notificationId: string, unreadCount: number) => Promise<void> | void;
  processEvent?: (row: NotificationOutboxRecord) => Promise<void>;
};

const STALE_PROCESSING_MS = 5 * 60_000;

export function createNotificationWorker(deps: WorkerDeps) {
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? 50, 200));
  const intervalMs = Math.max(100, deps.intervalMs ?? 1_000);
  const now = deps.now ?? (() => new Date());
  const jitter = deps.jitter ?? (() => Math.floor(Math.random() * 250));
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  let active: Promise<void> | undefined;

  async function process(row: NotificationOutboxRecord): Promise<void> {
    if (deps.processEvent) return deps.processEvent(row);
    const payload = parsePayload(row.payload);
    if (!row.recipientId || payload.recipientId !== row.recipientId) {
      throw new AppError(400, "Notification outbox fanout payload is not supported.", "NOTIFICATION_FANOUT_UNSUPPORTED");
    }
    if (!deps.service.persistFromEvent) throw new Error("Notification worker persistence service is not configured.");
    const result = await deps.service.persistFromEvent(row.eventType, payload, {
      dedupeKey: row.dedupeKey,
      ...(isAggregateEvent(row.eventType) ? { aggregationKey: aggregateKey(row) } : {}),
    });
    // A non-aggregate row can be retried after persistence succeeded but its
    // signal failed. Re-publishing that id is safe and prevents losing SSE.
    if (!result.row || (isAggregateEvent(row.eventType) && !result.changed && row.attempts <= 1)) return;
    const unreadCount = deps.service.unreadCount ? await deps.service.unreadCount(result.row.userId) : 0;
    if (deps.publishSignal) await deps.publishSignal(result.row.userId, result.row.id, unreadCount);
    else if (deps.service.signalPersisted) await deps.service.signalPersisted(result.row.userId, result.row.id, unreadCount);
  }

  async function execute(): Promise<void> {
    const recoveredAt = now();
    const recovery = await deps.repository.recoverStaleProcessing(recoveredAt, new Date(recoveredAt.getTime() - STALE_PROCESSING_MS));
    for (const dead of recovery.dead) deps.logger?.error("Notification outbox event is dead.", { outboxId: dead.id, attempts: dead.attempts, reason: "stale_processing" });
    if (stopping) return;
    const rows = await deps.repository.claimReady(batchSize, now());
    for (const row of rows) {
      try {
        await process(row);
        await deps.repository.markProcessed(row.id, row.claimAttempt, now());
      } catch (error) {
        const message = errorMessage(error);
        const failedAt = now();
        const delay = Math.min(30_000, 1_000 * 2 ** (row.attempts - 1)) + Math.max(0, jitter());
        const state = await deps.repository.markFailure(row.id, row.claimAttempt, message, new Date(failedAt.getTime() + delay), failedAt);
        if (state === NotificationOutboxState.DEAD) deps.logger?.error("Notification outbox event is dead.", { outboxId: row.id, attempts: row.attempts, error: message });
      }
    }
  }

  const scheduleRun = () => {
    void runOnce().catch((error: unknown) => deps.logger?.error("Notification worker run failed.", { error: errorMessage(error) }));
  };
  const runOnce = async (): Promise<void> => {
    if (stopping) return;
    if (active) return active;
    active = execute();
    try { await active; } finally { active = undefined; }
  };
  return {
    runOnce,
    start(): void {
      if (timer) return;
      stopping = false;
      scheduleRun();
      timer = setInterval(scheduleRun, intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}

function isAggregateEvent(type: NotificationType): boolean { return type === NotificationType.LISTING_FAVORITED_AGGREGATE || type === NotificationType.SAVED_SEARCH_MATCHES; }
function aggregateKey(row: NotificationOutboxRecord): string {
  const raw = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>)._aggregationKey : undefined;
  if (raw !== undefined && (typeof raw !== "string" || raw.length === 0 || raw.length > 160 || !/^[A-Za-z0-9:_-]+$/.test(raw))) throw new AppError(400, "Invalid notification aggregation key.", "VALIDATION_ERROR");
  if (typeof raw === "string" && /:\d{4}-\d{2}-\d{2}T\d{2}$/.test(raw)) return raw;
  return `${raw ?? `${row.eventType}:${row.recipientId}:${row.aggregateId}`}:${row.createdAt.toISOString().slice(0, 13)}`;
}
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }

function parsePayload(value: unknown): NotificationEventPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  const payload = value as Record<string, unknown>;
  if (typeof payload.eventType !== "string" || typeof payload.recipientId !== "string" || !payload.recipientId) throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  if (!Object.values(NotificationType).includes(payload.eventType as NotificationType)) throw new AppError(400, "Invalid notification event type.", "VALIDATION_ERROR");
  const stringFields: Record<NotificationType, readonly string[]> = {
    MESSAGE_RECEIVED: ["conversationId", "messageId", "senderId", "senderName", "listingId", "messagePreview"],
    LISTING_APPROVED: ["listingId", "listingTitle"], LISTING_REJECTED: ["listingId", "listingTitle", "rejectionReason"],
    LISTING_EXPIRING: ["listingId", "listingTitle", "expiresAt"], LISTING_EXPIRED: ["listingId", "listingTitle"],
    LISTING_FAVORITED_AGGREGATE: ["listingId", "listingTitle"], REVIEW_RECEIVED: ["reviewId", "reviewerId", "reviewerName", "listingId", "listingTitle"],
    SAVED_SEARCH_MATCHES: ["savedSearchId", "savedSearchName"], SYSTEM_ANNOUNCEMENT: ["announcementId", "title", "body"], SECURITY_ALERT: ["alertId"],
  };
  if (stringFields[payload.eventType as NotificationType].some((field) => typeof payload[field] !== "string")) throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  if (payload.eventType === NotificationType.LISTING_FAVORITED_AGGREGATE && typeof payload.favoriteCount !== "number") throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  if (payload.eventType === NotificationType.REVIEW_RECEIVED && typeof payload.rating !== "number") throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  if (payload.eventType === NotificationType.SAVED_SEARCH_MATCHES && (!Array.isArray(payload.matchingListingIds) || typeof payload.totalCount !== "number" || !payload.query || typeof payload.query !== "object" || Array.isArray(payload.query))) throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  if (payload.eventType === NotificationType.SYSTEM_ANNOUNCEMENT && payload.actionUrl !== undefined && payload.actionUrl !== null && typeof payload.actionUrl !== "string") throw new AppError(400, "Invalid notification outbox payload.", "VALIDATION_ERROR");
  return projectNotificationEventPayload(payload);
}

export async function runNotificationWorkerOnce(deps: { worker: Pick<ReturnType<typeof createNotificationWorker>, "runOnce">; disconnect?: () => Promise<void> }): Promise<void> {
  try { await deps.worker.runOnce(); }
  finally { await deps.disconnect?.(); }
}

if (require.main === module) {
  void (async () => {
    const [{ PrismaNotificationsRepository }, { NotificationsService }, { logger }] = await Promise.all([
      import("./notifications.repository"), import("./notifications.service"), import("../../config/logger"),
    ]);
    const repository = new PrismaNotificationsRepository();
    const { prisma } = await import("../../config/prisma");
    await runNotificationWorkerOnce({ worker: createNotificationWorker({ repository, service: new NotificationsService(repository), logger }), disconnect: () => prisma.$disconnect() });
  })().catch((error: unknown) => { process.exitCode = 1; process.stderr.write(`Notification worker failed: ${errorMessage(error)}\n`); });
}
