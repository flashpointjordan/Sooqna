import { NotificationOutboxState, Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../../shared/errors/appError";
import type { NotificationEventPayload } from "./notifications.types";

export type EnqueueNotificationEventInput = {
  payload: NotificationEventPayload;
  aggregateType: string;
  aggregateId: string;
  recipientId?: string;
  dedupeKey: string;
};

type OutboxWriter = Pick<PrismaClient, "notificationOutbox"> | Prisma.TransactionClient;

/**
 * Records domain facts for asynchronous delivery.  Rendering intentionally belongs
 * to the worker so the durable record never becomes a cache of private copy.
 */
export async function enqueueNotificationEvent(input: EnqueueNotificationEventInput, tx?: OutboxWriter) {
  const writer = tx ?? (await import("../../config/prisma")).prisma;
  const recipientId = input.recipientId ?? input.payload.recipientId;
  if (input.recipientId && input.recipientId !== input.payload.recipientId) {
    throw new AppError(400, "Notification recipient does not match event payload.", "VALIDATION_ERROR");
  }
  if (!input.aggregateType || !input.aggregateId || !input.dedupeKey) {
    throw new AppError(400, "Notification outbox identifiers are required.", "VALIDATION_ERROR");
  }
  const availableAt = new Date();
  return writer.notificationOutbox.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      eventType: input.payload.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      recipientId,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey,
      state: NotificationOutboxState.PENDING,
      attempts: 0,
      availableAt,
    },
    update: {},
  });
}
