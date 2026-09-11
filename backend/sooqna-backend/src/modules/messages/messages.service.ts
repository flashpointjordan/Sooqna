import { generateId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { AppError } from "../../shared/errors/appError";
import type { MessagesRepository } from "./repositories/messages.repository";
import type { Conversation, CreateMessageInput, Message } from "./messages.types";

type CreateConversationInput = {
  participantIds: string[];
  participants: Conversation["participants"];
  listingId: string;
  listingSnapshot: Conversation["listingSnapshot"];
  createdBy: string;
};

export class MessagesService {
  constructor(private readonly repo: MessagesRepository) {}

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    if (!input.listingId.trim()) {
      throw new AppError(400, "listingId is required", "VALIDATION_ERROR");
    }
    if (!input.listingSnapshot.title.trim()) {
      throw new AppError(400, "listingSnapshot.title is required", "VALIDATION_ERROR");
    }

    const participantIds = Array.from(
      new Set(input.participantIds.map((participantId) => participantId.trim()).filter(Boolean))
    );
    if (!participantIds.length) {
      throw new AppError(400, "participantIds must contain at least one id", "VALIDATION_ERROR");
    }

    const now = nowIso();
    const existingConversations = await this.repo.listConversationsForUser(input.createdBy);
    const sortedParticipants = [...participantIds].sort().join("|");
    const duplicate = existingConversations.find(
      (conversation) =>
        conversation.listingId === input.listingId &&
        [...conversation.participantIds].sort().join("|") === sortedParticipants
    );
    if (duplicate) {
      return duplicate;
    }

    const conversation: Conversation = {
      id: generateId("conv"),
      participantIds,
      participants: input.participants,
      listingId: input.listingId,
      listingSnapshot: input.listingSnapshot,
      createdBy: input.createdBy,
      lastMessageText: "",
      lastMessageSenderId: "",
      lastMessageAt: null,
      lastMessageType: "text",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    return this.repo.createConversation(conversation);
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const now = nowIso();
    const conversation = await this.repo.findConversationById(input.conversationId);
    if (!conversation) throw new AppError(404, "Conversation not found", "NOT_FOUND");
    if (!conversation.participantIds.includes(input.senderId)) {
      throw new AppError(
        403,
        "You are not a participant in this conversation.",
        "FORBIDDEN"
      );
    }
    if (input.type === "text" && !input.text.trim()) {
      throw new AppError(400, "text is required for text messages", "VALIDATION_ERROR");
    }

    const message: Message = {
      id: generateId("msg"),
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type,
      text: input.text,
      attachments: input.attachments ?? [],
      isRead: false,
      readAt: null,
      createdAt: now,
      deletedAt: null,
    };

    await this.repo.createMessage(message);
    await this.repo.updateConversation({
      ...conversation,
      lastMessageText: input.text,
      lastMessageSenderId: input.senderId,
      lastMessageAt: now,
      lastMessageType: input.type,
      updatedAt: now,
    });

    return message;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.repo.findConversationById(id);
  }

  async listUserConversations(userId: string): Promise<Conversation[]> {
    if (!userId.trim()) {
      throw new AppError(400, "userId is required", "VALIDATION_ERROR");
    }
    const [conversations, unreadMap] = await Promise.all([
      this.repo.listConversationsForUser(userId),
      this.repo.getUnreadCountMapForUser(userId),
    ]);
    return conversations.map((conversation) => ({
      ...conversation,
      unreadCount: unreadMap[conversation.id] ?? 0,
    }));
  }

  async getConversationForUser(id: string, userId: string): Promise<Conversation> {
    const conversation = await this.repo.findConversationById(id);
    if (!conversation) {
      throw new AppError(404, "Conversation not found", "NOT_FOUND");
    }
    if (!conversation.participantIds.includes(userId)) {
      throw new AppError(
        403,
        "You are not a participant in this conversation.",
        "FORBIDDEN"
      );
    }
    return conversation;
  }

  async getMessages(conversationId: string, userId: string): Promise<Message[]> {
    await this.getConversationForUser(conversationId, userId);
    return this.repo.listMessages(conversationId);
  }

  async markConversationRead(conversationId: string, userId: string): Promise<number> {
    await this.getConversationForUser(conversationId, userId);
    return this.repo.markConversationMessagesRead(conversationId, userId);
  }

  async getUnreadSummary(userId: string): Promise<{
    totalUnread: number;
    byConversation: Record<string, number>;
  }> {
    if (!userId.trim()) {
      throw new AppError(400, "userId is required", "VALIDATION_ERROR");
    }
    const byConversation = await this.repo.getUnreadCountMapForUser(userId);
    const totalUnread = Object.values(byConversation).reduce((sum, count) => sum + count, 0);
    return { totalUnread, byConversation };
  }
}

