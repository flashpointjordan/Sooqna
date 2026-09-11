import * as path from "node:path";
import { open, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { env } from "../../../config/env";
import { prisma } from "../../../config/prisma";
import { parseIso, toIso } from "../../../shared/utils/dates";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../../utils/fileStore";
import type { Conversation, Message } from "../messages.types";
import type { CreateMessageResult } from "../messages.types";
import { Prisma } from "@prisma/client";
import { PrismaTransactionRunner, type TransactionContext, type TransactionRunner } from "../../../shared/database/unitOfWork";
import type { EnqueueNotificationEventInput } from "../../notifications/notifications.producer";

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
  markConversationMessagesRead(conversationId: string, readerId: string): Promise<number>;
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
const messagesStateDataPath = path.resolve(
  process.cwd(),
  "src/modules/messages/repositories/messages-state.data.json"
);
const messagesStateLockPath = `${messagesStateDataPath}.lock`;

type JsonMessagesState = {
  conversations: Conversation[];
  messages: Message[];
  notificationOutbox: Array<Record<string, unknown>>;
};

let jsonMessageWriteQueue: Promise<void> = Promise.resolve();

async function withJsonMessageFileLock<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const handle = await open(messagesStateLockPath, "wx");
      try {
        return await work();
      } finally {
        await handle.close();
        await unlink(messagesStateLockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      await delay(10);
    }
  }
  throw new Error("Timed out waiting for the JSON message state lock.");
}

function serializeJsonMessageWrite<T>(work: () => Promise<T>): Promise<T> {
  const lockedWork = () => withJsonMessageFileLock(work);
  const result = jsonMessageWriteQueue.then(lockedWork, lockedWork);
  jsonMessageWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

function readJsonMessageState(): JsonMessagesState {
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

function writeJsonMessageState(state: JsonMessagesState): void {
  writeJsonArrayFileAtomically(messagesStateDataPath, [state]);
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
          const state = readJsonMessageState();
          state.conversations.push(conversation);
          writeJsonMessageState(state);
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
        return readJsonMessageState().conversations.find((conversation) => conversation.id === id) ?? null;
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
        return readJsonMessageState().conversations
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
          const state = readJsonMessageState();
          const idx = state.conversations.findIndex((item) => item.id === conversation.id);
          if (idx < 0) throw new Error("Conversation not found");
          state.conversations[idx] = conversation;
          writeJsonMessageState(state);
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
          const state = readJsonMessageState();
          state.messages.push(message);
          writeJsonMessageState(state);
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

    let transactionStarted = false;
    try {
      return await this.transactions.run(async (tx) => {
        transactionStarted = true;
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
              { lastMessageAt: { lte: new Date(input.message.createdAt) } },
            ],
          },
          data: conversationUpdateData(input.message),
        });
        for (const notification of input.notifications) {
          await enqueue(notification, tx);
        }
        return { message: mapMessage(created), created: true };
      });
    } catch (error) {
      if (useJsonFallback() && !transactionStarted) {
        return this.createMessageAtomicallyInJson(input, enqueue);
      }
      throw error;
    }
  }

  private async createMessageAtomicallyInJson(
    input: AtomicMessageInput,
    enqueue: NotificationEnqueuer
  ): Promise<CreateMessageResult> {
    return serializeJsonMessageWrite(async () => {
      const state = readJsonMessageState();
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
        currentConversation.lastMessageAt <= input.message.createdAt
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
      writeJsonMessageState(state);
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
        return readJsonMessageState().messages
          .filter((item) => item.conversationId === conversationId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((item) => ({ ...item, clientRequestId: item.clientRequestId ?? null }));
      }
      throw new Error("Failed to list messages.", { cause: error });
    }
  }

  async markConversationMessagesRead(conversationId: string, readerId: string): Promise<number> {
    try {
      const result = await prisma.message.updateMany({
        where: {
          conversationId,
          senderId: { not: readerId },
          isRead: false,
          deletedAt: null,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });
      return result.count;
    } catch (error) {
      if (useJsonFallback()) {
        return serializeJsonMessageWrite(async () => {
          const state = readJsonMessageState();
          let updated = 0;
          state.messages = state.messages.map((message) => {
            if (
              message.conversationId === conversationId &&
              message.senderId !== readerId &&
              !message.isRead &&
              message.deletedAt === null
            ) {
              updated += 1;
              return { ...message, isRead: true, readAt: new Date().toISOString() };
            }
            return message;
          });
          writeJsonMessageState(state);
          return updated;
        });
      }
      throw new Error("Failed to mark conversation messages as read.", { cause: error });
    }
  }

  async getUnreadCountMapForUser(userId: string): Promise<Record<string, number>> {
    try {
      const unreadMessages = await prisma.message.findMany({
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
        select: {
          conversationId: true,
        },
      });

      return unreadMessages.reduce<Record<string, number>>((acc, item) => {
        acc[item.conversationId] = (acc[item.conversationId] ?? 0) + 1;
        return acc;
      }, {});
    } catch (error) {
      if (useJsonFallback()) {
        const state = readJsonMessageState();
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

