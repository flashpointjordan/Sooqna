import { MESSAGE_TYPES } from "../../shared/constants/domain";

export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface CreateMessageInput {
  conversationId: string;
  senderId: string;
  clientRequestId: string;
  type: MessageType;
  text: string;
  attachments?: unknown[];
}

export interface Conversation {
  id: string;
  participantIds: string[];
  participants: Record<string, { fullName: string; photoURL: string }>;
  listingId: string;
  listingSnapshot: {
    title: string;
    primaryImageURL: string;
  };
  createdBy: string;
  lastMessageText: string;
  lastMessageSenderId: string;
  lastMessageAt: string | null;
  lastMessageType: MessageType;
  isActive: boolean;
  unreadCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  clientRequestId: string | null;
  type: MessageType;
  text: string;
  attachments: unknown[];
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export type CreateMessageResult = {
  message: Message;
  created: boolean;
};

