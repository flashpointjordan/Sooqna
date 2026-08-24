import { apiFetch } from "@/services/apiClient";
import { withRetry } from "@/services/requestRetry";
import type {
  Conversation,
  CreateConversationInput,
  CreateMessageInput,
  Message,
  UnreadSummary,
} from "@/types/message";

type PendingMessage = {
  id: string;
  conversationId: string;
  payload: CreateMessageInput;
  createdAt: string;
};

const PENDING_MESSAGES_KEY = "sooqna_pending_messages_v1";

function readPendingMessages(): PendingMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PENDING_MESSAGES_KEY);
    return raw ? (JSON.parse(raw) as PendingMessage[]) : [];
  } catch {
    return [];
  }
}

function writePendingMessages(items: PendingMessage[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PENDING_MESSAGES_KEY, JSON.stringify(items));
}

export async function getConversationById(
  conversationId: string
): Promise<Conversation | null> {
  try {
    const response = await withRetry(() =>
      apiFetch<{ success: true; conversation: Conversation }>(
        `/messages/conversations/${conversationId}`,
        { authenticated: true }
      )
    );
    return response.conversation;
  } catch {
    return null;
  }
}

export async function getMyConversations(): Promise<Conversation[]> {
  const response = await withRetry(() =>
    apiFetch<{ success: true; conversations: Conversation[] }>("/messages/conversations", {
      authenticated: true,
    })
  );
  return response.conversations;
}

export async function getConversationMessages(
  conversationId: string
): Promise<Message[]> {
  const response = await withRetry(() =>
    apiFetch<{ success: true; messages: Message[] }>(
      `/messages/conversations/${conversationId}/messages`,
      { authenticated: true }
    )
  );
  return response.messages;
}

export async function createConversation(
  input: CreateConversationInput
): Promise<{ conversationId: string }> {
  const response = await apiFetch<{ success: true; conversation: Conversation }>(
    "/messages/conversations",
    {
      method: "POST",
      authenticated: true,
      body: JSON.stringify({ listingId: input.listingId }),
    }
  );

  return { conversationId: response.conversation.id };
}

export async function createMessage(
  conversationId: string,
  input: CreateMessageInput
): Promise<{ messageId: string }> {
  const response = await apiFetch<{ success: true; message: Message }>(
    `/messages/conversations/${conversationId}/messages`,
    {
      method: "POST",
      authenticated: true,
      body: JSON.stringify({
        type: input.type,
        text: input.text,
        attachments: input.attachments ?? [],
      }),
    }
  );
  return { messageId: response.message.id };
}

export async function markConversationRead(conversationId: string): Promise<number> {
  const response = await apiFetch<{ success: true; updatedCount: number }>(
    `/messages/conversations/${conversationId}/read`,
    {
      method: "POST",
      authenticated: true,
    }
  );
  return response.updatedCount;
}

export async function getUnreadSummary(): Promise<UnreadSummary> {
  const response = await withRetry(() =>
    apiFetch<{ success: true; totalUnread: number; byConversation: Record<string, number> }>(
      "/messages/conversations/unread-summary",
      { authenticated: true }
    )
  );
  return { totalUnread: response.totalUnread, byConversation: response.byConversation };
}

export function enqueuePendingMessage(conversationId: string, payload: CreateMessageInput): void {
  const queue = readPendingMessages();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    conversationId,
    payload,
    createdAt: new Date().toISOString(),
  });
  writePendingMessages(queue);
}

export async function flushPendingMessages(): Promise<number> {
  const queue = readPendingMessages();
  if (!queue.length) return 0;
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;
  const remaining: PendingMessage[] = [];
  let flushed = 0;
  for (const item of queue) {
    try {
      await createMessage(item.conversationId, item.payload);
      flushed += 1;
    } catch {
      remaining.push(item);
    }
  }
  writePendingMessages(remaining);
  return flushed;
}
