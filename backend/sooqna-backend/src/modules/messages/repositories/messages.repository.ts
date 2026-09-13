import * as path from "node:path";
import { env } from "../../../config/env";
import { prisma } from "../../../config/prisma";
import { parseIso, toIso } from "../../../shared/utils/dates";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../../utils/fileStore";
import type { Conversation, ConversationReadResult, Message } from "../messages.types";
import type { CreateMessageResult } from "../messages.types";
import { Prisma } from "@prisma/client";
import { PrismaTransactionRunner, type TransactionContext, type TransactionRunner } from "../../../shared/database/unitOfWork";
import { withMarketplaceJsonLock } from "../../../shared/database/marketplaceJsonLock";
import type { EnqueueNotificationEventInput } from "../../notifications/notifications.producer";
import { AppError } from "../../../shared/errors/appError";
import { lockConversationMutation } from "../../../shared/database/conversationMutationLock";
import {
  commitJsonConversationReadUnlocked,
  messagesStateDataPath,
  readJsonNotificationStateUnlocked,
  recoverJsonConversationReadUnlocked,
} from "./conversationReadJsonCoordinator";

type AtomicMessageInput = {
  message: Message;
  conversation: Conversation;
  notifications: EnqueueNotificationEventInput[];
};

type NotificationEnqueuer = (
  input: EnqueueNotificationEventInput,
  tx?: TransactionContext
) => Promise<unknown>;

export interface MessagesRepository {
  createConversation(conversation: Conversation): Promise<Conversation>;
  findConversationById(id: string): Promise<Conversation | null>;
  listConversationsForUser(userId: string): Promise<Conversation[]>;
  updateConversation(conversation: Conversation): Promise<Conversation>;
  createMessage(message: Message): Promise<Message>;
  createMessageAtomically(input: AtomicMessageInput, enqueue: NotificationEnqueuer): Promise<CreateMessageResult>;
  listMessages(conversationId: string): Promise<Message[]>;
  reconcileConversationRead(
    conversationId: string,
    readerId: string,
    now: Date
  ): Promise<ConversationReadResult>;
  getUnreadCountMapForUser(userId: string): Promise<Record<string, number>>;
}

const conversationsDataPath = path.resolve(
  process.cwd(),
  "src/modules/messages/repositories/conversations.data.json"
);
const messagesDataPath = path.resolve(
  process.cwd(),
  "src/modules/messages/repositories/messages.data.json"
);
const legacyNotificationOutboxDataPath = path.resolve(
  process.cwd(),
  "src/modules/notifications/notification-outbox.data.json"
);
export type JsonMessagesState = {
  conversations: Conversation[];
  messages: Message[];
  notificationOutbox: Array<Record<string, unknown>>;
};

let jsonMessageWriteQueue: Promise<void> = Promise.resolve();

function serializeJsonMessageWrite<T>(work: () => Promise<T>): Promise<T> {
  const lockedWork = () => withMarketplaceJsonLock(work);
  const result = jsonMessageWriteQueue.then(lockedWork, lockedWork);
  jsonMessageWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function readJsonMessageFallbackStateUnlocked(): JsonMessagesState {
  recoverJsonConversationReadUnlocked();
  const state = readJsonArrayFile<JsonMessagesState>(messagesStateDataPath)[0];
  if (state) return state;
  return {
    conversations: readJsonArrayFile<Conversation>(conversationsDataPath),
    messages: readJsonArrayFile<Message>(messagesDataPath).map((item) => ({
      ...item,
      clientRequestId: item.clientRequestId ?? null,
    })),
    notificationOutbox: readJsonArrayFile<Record<string, unknown>>(legacyNotificationOutboxDataPath),
  };
}

export function writeJsonMessageFallbackStateUnlocked(state: JsonMessagesState): void {
  writeJsonArrayFileAtomically(messagesStateDataPath, [state]);
}

export function mutateJsonMessageFallbackState<T>(
  work: (state: JsonMessagesState) => Promise<T> | T
): Promise<T> {
  return serializeJsonMessageWrite(async () => {
    const state = readJsonMessageFallbackStateUnlocked();
    const result = await work(state);
    writeJsonMessageFallbackStateUnlocked(state);
    return result;
  });
}

function useJsonFallback(): boolean {
  return env.enableCategoriesJsonFallback;
}

function messageCreateData(message: Message): Prisma.MessageUncheckedCreateInput {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientRequestId: message.clientRequestId,
    type: message.type,
    text: message.text,
    attachments: message.attachments as Prisma.InputJsonValue,
    isRead: message.isRead,
    readAt: parseIso(message.readAt),
    createdAt: new Date(message.createdAt),
    deletedAt: parseIso(message.deletedAt),
  };
}

function conversationUpdateData(message: Message): Prisma.ConversationUpdateManyMutationInput {
  return {
    lastMessageText: message.text,
    lastMessageSenderId: message.senderId,
    lastMessageAt: new Date(message.createdAt),
    lastMessageType: message.type,
    updatedAt: new Date(message.createdAt),
  };
}

function mapMessage(item: {
  id: string;
  conversationId: string;
  senderId: string;
  clientRequestId: string | null;
  type: string;
  text: string;
  attachments: unknown;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}): Message {
  return {
    id: item.id,
    conversationId: item.conversationId,
    senderId: item.senderId,
    clientRequestId: item.clientRequestId,
    type: item.type as Message["type"],
    text: item.text,
    attachments: Array.isArray(item.attachments) ? item.attachments : [],
    isRead: item.isRead,
    readAt: toIso(item.readAt),
    createdAt: item.createdAt.toISOString(),
    deletedAt: toIso(item.deletedAt),
  };
}

export class PrismaMessagesRepository implements MessagesRepository {
  private readonly transactions: TransactionRunner;

  constructor(transactions: TransactionRunner = new PrismaTransactionRunner(prisma)) {
    this.transactions = transactions;
  }

  async createConversation(conversation: Conversation): Promise<Conversation> {
    try {
      const created = await prisma.conversation.create({
        data: {
          id: conversation.id,
          listingId: conversation.listingId,
          listingSnapshotTitle: conversation.listingSnapshot.title,
          listingSnapshotPrimaryImageURL: conversation.listingSnapshot.primaryImageURL,
          createdBy: conversation.createdBy,
          lastMessageText: conversation.lastMessageText,
          lastMessageSenderId: conversation.lastMessageSenderId,
          lastMessageAt: parseIso(conversation.lastMessageAt),
          lastMessageType: conversation.lastMessageType,
          isActive: conversation.isActive,
          createdAt: new Date(conversation.createdAt),
          updatedAt: new Date(conversation.updatedAt),
          participants: {
            create: conversation.participantIds.map((participantId) => ({
              userId: participantId,
              fullName: conversation.participants[participantId]?.fullName ?? "",
              photoURL: conversation.participants[participantId]?.photoURL ?? "",
            })),
          },
        },
        include: { participants: true },
      });

      const participants: Conversation["participants"] = {};
      for (const participant of created.participants) {
        participants[participant.userId] = {
          fullName: participant.fullName,
          photoURL: participant.photoURL,
        };
      }

      return {
        id: created.id,
        participantIds: created.participants.map((p) => p.userId),
        participants,
        listingId: created.listingId,
        listingSnapshot: {
          title: created.listingSnapshotTitle,
          primaryImageURL: created.listingSnapshotPrimaryImageURL,
        },
        createdBy: created.createdBy,
        lastMessageText: created.lastMessageText,
        lastMessageSenderId: created.lastMessageSenderId,
        lastMessageAt: toIso(created.lastMessageAt),
        lastMessageType: created.lastMessageType as Conversation["lastMessageType"],
        isActive: created.isActive,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      };
    } catch (error) {
      if (useJsonFallback()) {
        return serializeJsonMessageWrite(async () => {
          const state = readJsonMessageFallbackStateUnlocked();
          state.conversations.push(conversation);
          writeJsonMessageFallbackStateUnlocked(state);
          return conversation;
        });
      }
      throw new Error("Failed to create conversation.", { cause: error });
    }
  }

  async findConversationById(id: string): Promise<Conversation | null> {
    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id },
        include: { participants: true },
      });
      if (!conversation) return null;

      const participants: Conversation["participants"] = {};
      for (const participant of conversation.participants) {
        participants[participant.userId] = {
          fullName: participant.fullName,
          photoURL: participant.photoURL,
        };
      }

      return {
        id: conversation.id,
        participantIds: conversation.participants.map((p) => p.userId),
        participants,
        listingId: conversation.listingId,
        listingSnapshot: {
          title: conversation.listingSnapshotTitle,
          primaryImageURL: conversation.listingSnapshotPrimaryImageURL,
        },
        createdBy: conversation.createdBy,
        lastMessageText: conversation.lastMessageText,
        lastMessageSenderId: conversation.lastMessageSenderId,
        lastMessageAt: toIso(conversation.lastMessageAt),
        lastMessageType: conversation.lastMessageType as Conversation["lastMessageType"],
        isActive: conversation.isActive,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      };
    } catch (error) {
      if (useJsonFallback()) {
        return readJsonMessageFallbackStateUnlocked().conversations.find((conversation) => conversation.id === id) ?? null;
      }
      throw new Error("Failed to fetch conversation.", { cause: error });
    }
  }

  async listConversationsForUser(userId: string): Promise<Conversation[]> {
    try {
      const items = await prisma.conversation.findMany({
        where: {
          participants: {
            some: {
              userId,
            },
          },
        },
        include: { participants: true },
        orderBy: { updatedAt: "desc" },
      });

      return items.map((conversation) => {
        const participants: Conversation["participants"] = {};
        for (const participant of conversation.participants) {
          participants[participant.userId] = {
            fullName: participant.fullName,
            photoURL: participant.photoURL,
          };
        }

        return {
          id: conversation.id,
          participantIds: conversation.participants.map((p) => p.userId),
          participants,
          listingId: conversation.listingId,
          listingSnapshot: {
            title: conversation.listingSnapshotTitle,
            primaryImageURL: conversation.listingSnapshotPrimaryImageURL,
          },
          createdBy: conversation.createdBy,
          lastMessageText: conversation.lastMessageText,
          lastMessageSenderId: conversation.lastMessageSenderId,
          lastMessageAt: toIso(conversation.lastMessageAt),
          lastMessageType: conversation.lastMessageType as Conversation["lastMessageType"],
          isActive: conversation.isActive,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
        };
      });
    } catch (error) {
      if (useJsonFallback()) {
        return readJsonMessageFallbackStateUnlocked().conversations
          .filter((conversation) => conversation.participantIds.includes(userId))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      throw new Error("Failed to list conversations.", { cause: error });
    }
  }

  async updateConversation(conversation: Conversation): Promise<Conversation> {
    try {
      const updated = await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          listingId: conversation.listingId,
          listingSnapshotTitle: conversation.listingSnapshot.title,
          listingSnapshotPrimaryImageURL: conversation.listingSnapshot.primaryImageURL,
          createdBy: conversation.createdBy,
          lastMessageText: conversation.lastMessageText,
          lastMessageSenderId: conversation.lastMessageSenderId,
          lastMessageAt: parseIso(conversation.lastMessageAt),
          lastMessageType: conversation.lastMessageType,
          isActive: conversation.isActive,
          createdAt: new Date(conversation.createdAt),
          updatedAt: new Date(conversation.updatedAt),
        },
      });
      return {
        ...conversation,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };
    } catch (error) {
      if (useJsonFallback()) {
        return serializeJsonMessageWrite(async () => {
          const state = readJsonMessageFallbackStateUnlocked();
          const idx = state.conversations.findIndex((item) => item.id === conversation.id);
          if (idx < 0) throw new Error("Conversation not found");
          state.conversations[idx] = conversation;
          writeJsonMessageFallbackStateUnlocked(state);
          return conversation;
        });
      }
      throw new Error("Conversation not found.", { cause: error });
    }
  }

  async createMessage(message: Message): Promise<Message> {
    try {
      const created = await prisma.message.create({
        data: {
          ...messageCreateData(message),
        },
      });
      return {
        id: created.id,
        conversationId: created.conversationId,
        senderId: created.senderId,
        clientRequestId: created.clientRequestId,
        type: created.type as Message["type"],
        text: created.text,
        attachments: Array.isArray(created.attachments) ? created.attachments : [],
        isRead: created.isRead,
        readAt: toIso(created.readAt),
        createdAt: created.createdAt.toISOString(),
        deletedAt: toIso(created.deletedAt),
      };
    } catch (error) {
      if (useJsonFallback()) {
        return serializeJsonMessageWrite(async () => {
          const state = readJsonMessageFallbackStateUnlocked();
          state.messages.push(message);
          writeJsonMessageFallbackStateUnlocked(state);
          return message;
        });
      }
      throw new Error("Failed to create message.", { cause: error });
    }
  }

  async createMessageAtomically(
    input: AtomicMessageInput,
    enqueue: NotificationEnqueuer
  ): Promise<CreateMessageResult> {
    if (useJsonFallback() && !env.databaseUrl) {
      return this.createMessageAtomicallyInJson(input, enqueue);
    }

    return this.transactions.run(async (tx) => {
      await lockConversationMutation(tx, input.message.conversationId);
      const idempotencyScope = [
        input.message.conversationId,
        input.message.senderId,
        input.message.clientRequestId ?? "",
      ].join(":");
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyScope}, 0))`
      );
      const existing = await tx.message.findUnique({
        where: {
          conversationId_senderId_clientRequestId: {
            conversationId: input.message.conversationId,
            senderId: input.message.senderId,
            clientRequestId: input.message.clientRequestId ?? "",
          },
        },
      });
      if (existing) return { message: mapMessage(existing), created: false };

      const created = await tx.message.create({ data: messageCreateData(input.message) });
      await tx.conversation.updateMany({
        where: {
          id: input.conversation.id,
          OR: [
            { lastMessageAt: null },
            { lastMessageAt: { lt: new Date(input.message.createdAt) } },
          ],
        },
        data: conversationUpdateData(input.message),
      });
      for (const notification of input.notifications) {
        await enqueue(notification, tx);
      }
      return { message: mapMessage(created), created: true };
    });
  }

  private async createMessageAtomicallyInJson(
    input: AtomicMessageInput,
    enqueue: NotificationEnqueuer
  ): Promise<CreateMessageResult> {
    return serializeJsonMessageWrite(async () => {
      const state = readJsonMessageFallbackStateUnlocked();
      const existing = state.messages.find(
        (message) =>
          message.conversationId === input.message.conversationId &&
          message.senderId === input.message.senderId &&
          message.clientRequestId === input.message.clientRequestId
      );
      if (existing) {
        return {
          message: { ...existing, clientRequestId: existing.clientRequestId ?? null },
          created: false,
        };
      }

      const conversationIndex = state.conversations.findIndex(
        (item) => item.id === input.conversation.id
      );
      if (conversationIndex < 0) throw new Error("Conversation not found");

      const jsonTransaction = {
        notificationOutbox: {
          upsert: async (args: {
            where: { dedupeKey: string };
            create: Record<string, unknown>;
          }) => {
            const existingEvent = state.notificationOutbox.find(
              (event) => event.dedupeKey === args.where.dedupeKey
            );
            if (existingEvent) return existingEvent;
            const now = new Date().toISOString();
            const created = {
              id: `outbox_${Date.now()}_${state.notificationOutbox.length + 1}`,
              ...args.create,
              availableAt:
                args.create.availableAt instanceof Date
                  ? args.create.availableAt.toISOString()
                  : args.create.availableAt,
              createdAt: now,
              updatedAt: now,
            };
            state.notificationOutbox.push(created);
            return created;
          },
        },
      } as unknown as TransactionContext;
      for (const notification of input.notifications) {
        await enqueue(notification, jsonTransaction);
      }
      state.messages.push(input.message);
      const currentConversation = state.conversations[conversationIndex];
      if (
        !currentConversation.lastMessageAt ||
        currentConversation.lastMessageAt < input.message.createdAt
      ) {
        state.conversations[conversationIndex] = {
          ...currentConversation,
          lastMessageText: input.message.text,
          lastMessageSenderId: input.message.senderId,
          lastMessageAt: input.message.createdAt,
          lastMessageType: input.message.type,
          updatedAt: input.message.createdAt,
        };
      }
      writeJsonMessageFallbackStateUnlocked(state);
      return { message: input.message, created: true };
    });
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    try {
      const items = await prisma.message.findMany({
        where: { conversationId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });
      return items.map((item) => ({
        id: item.id,
        conversationId: item.conversationId,
        senderId: item.senderId,
        clientRequestId: item.clientRequestId ?? null,
        type: item.type as Message["type"],
        text: item.text,
        attachments: Array.isArray(item.attachments) ? item.attachments : [],
        isRead: item.isRead,
        readAt: toIso(item.readAt),
        createdAt: item.createdAt.toISOString(),
        deletedAt: toIso(item.deletedAt),
      }));
    } catch (error) {
      if (useJsonFallback()) {
        return readJsonMessageFallbackStateUnlocked().messages
          .filter((item) => item.conversationId === conversationId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((item) => ({ ...item, clientRequestId: item.clientRequestId ?? null }));
      }
      throw new Error("Failed to list messages.", { cause: error });
    }
  }

  async reconcileConversationRead(
    conversationId: string,
    readerId: string,
    now: Date
  ): Promise<ConversationReadResult> {
    if (useJsonFallback() && !env.databaseUrl) {
      return serializeJsonMessageWrite(async () => {
        const messageState = readJsonMessageFallbackStateUnlocked();
        const notificationState = readJsonNotificationStateUnlocked();
        const conversation = messageState.conversations.find((item) => item.id === conversationId);
        if (!conversation?.participantIds.includes(readerId)) {
          throw new AppError(
            403,
            "You are not a participant in this conversation.",
            "FORBIDDEN"
          );
        }
        let updatedMessages = 0;
        let updatedNotifications = 0;

        messageState.messages = messageState.messages.map((message) => {
          if (
            message.conversationId === conversationId &&
            message.senderId !== readerId &&
            !message.isRead &&
            message.deletedAt === null
          ) {
            updatedMessages += 1;
            return { ...message, isRead: true, readAt: now.toISOString() };
          }
          return message;
        });
        notificationState.notifications = notificationState.notifications.map((notification) => {
          if (
            notification.userId === readerId &&
            notification.type === "MESSAGE_RECEIVED" &&
            notification.entityType === "conversation" &&
            notification.entityId === conversationId &&
            !notification.readAt &&
            !notification.deletedAt &&
            new Date(notification.expiresAt) > now
          ) {
            updatedNotifications += 1;
            return { ...notification, readAt: now, updatedAt: now };
          }
          return notification;
        });

        const ownedConversations = new Set(
          messageState.conversations
            .filter((conversation) => conversation.participantIds.includes(readerId))
            .map((conversation) => conversation.id)
        );
        const messageUnreadTotal = messageState.messages.filter(
          (message) =>
            ownedConversations.has(message.conversationId) &&
            message.senderId !== readerId &&
            !message.isRead &&
            message.deletedAt === null
        ).length;
        const notificationUnreadTotal = notificationState.notifications.filter(
          (notification) =>
            notification.userId === readerId &&
            !notification.readAt &&
            !notification.deletedAt &&
            new Date(notification.expiresAt) > now
        ).length;

        commitJsonConversationReadUnlocked(messageState, notificationState);
        return {
          updatedMessages,
          updatedNotifications,
          messageUnreadTotal,
          notificationUnreadTotal,
        };
      });
    }
    return this.transactions.run(async (tx) => {
      await lockConversationMutation(tx, conversationId);
      const participant = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "ConversationParticipant"
          WHERE "conversationId" = ${conversationId}
            AND "userId" = ${readerId}
          FOR SHARE
        `
      );
      if (participant.length === 0) {
        throw new AppError(
          403,
          "You are not a participant in this conversation.",
          "FORBIDDEN"
        );
      }
      const messages = await tx.message.updateMany({
        where: {
          conversationId,
          senderId: { not: readerId },
          isRead: false,
          deletedAt: null,
          conversation: { participants: { some: { userId: readerId } } },
        },
        data: { isRead: true, readAt: now },
      });
      const notifications = await tx.notification.updateMany({
        where: {
          userId: readerId,
          type: "MESSAGE_RECEIVED",
          entityType: "conversation",
          entityId: conversationId,
          readAt: null,
          deletedAt: null,
          expiresAt: { gt: now },
        },
        data: { readAt: now },
      });
      const [messageUnreadTotal, notificationUnreadTotal] = await Promise.all([
        tx.message.count({
          where: {
            senderId: { not: readerId },
            isRead: false,
            deletedAt: null,
            conversation: { participants: { some: { userId: readerId } } },
          },
        }),
        tx.notification.count({
          where: {
            userId: readerId,
            readAt: null,
            deletedAt: null,
            expiresAt: { gt: now },
          },
        }),
      ]);
      return {
        updatedMessages: messages.count,
        updatedNotifications: notifications.count,
        messageUnreadTotal,
        notificationUnreadTotal,
      };
    });
  }

  async getUnreadCountMapForUser(userId: string): Promise<Record<string, number>> {
    try {
      const unreadMessages = await prisma.message.groupBy({
        by: ["conversationId"],
        where: {
          senderId: { not: userId },
          isRead: false,
          deletedAt: null,
          conversation: {
            participants: {
              some: { userId },
            },
          },
        },
        _count: { _all: true },
      });

      return unreadMessages.reduce<Record<string, number>>((acc, item) => {
        acc[item.conversationId] = item._count._all;
        return acc;
      }, {});
    } catch (error) {
      if (useJsonFallback()) {
        const state = readJsonMessageFallbackStateUnlocked();
        const accessibleConversationIds = new Set(
          state.conversations
            .filter((conversation) => conversation.participantIds.includes(userId))
            .map((conversation) => conversation.id)
        );

        return state.messages.reduce<Record<string, number>>((acc, message) => {
          if (
            accessibleConversationIds.has(message.conversationId) &&
            message.senderId !== userId &&
            !message.isRead &&
            message.deletedAt === null
          ) {
            acc[message.conversationId] = (acc[message.conversationId] ?? 0) + 1;
          }
          return acc;
        }, {});
      }
      throw new Error("Failed to compute unread counters.", { cause: error });
    }
  }
}

