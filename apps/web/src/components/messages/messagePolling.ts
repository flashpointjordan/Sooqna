import { ApiRequestError } from "../../services/apiRequestError";
import type { UnreadSummary } from "../../types/message";

export function canPollMessages(input: {
  visibilityState: DocumentVisibilityState;
  blockedUntil: number;
  now: number;
}): boolean {
  return input.visibilityState === "visible" && input.now >= input.blockedUntil;
}

export function getRateLimitBlockedUntil(error: unknown, now: number): number | null {
  if (
    !(error instanceof ApiRequestError) ||
    error.status !== 429 ||
    error.retryAfterSeconds === null
  ) {
    return null;
  }
  return now + error.retryAfterSeconds * 1_000;
}

export function createSingleFlightRunner(): <T>(
  task: () => Promise<T>
) => Promise<boolean> {
  let inFlight = false;

  return async <T>(task: () => Promise<T>): Promise<boolean> => {
    if (inFlight) return false;
    inFlight = true;
    try {
      await task();
      return true;
    } finally {
      inFlight = false;
    }
  };
}

export async function refreshMessagePollCycle(input: {
  conversationId: string;
  refreshInbox: () => Promise<UnreadSummary>;
  refreshConversation: (conversationId: string) => Promise<void>;
  markRead: (conversationId: string) => Promise<number>;
  applyReadState: (conversationId: string, unreadCount: number) => void;
}): Promise<void> {
  const conversationRefresh = input.conversationId
    ? input.refreshConversation(input.conversationId)
    : Promise.resolve();
  const [summary] = await Promise.all([input.refreshInbox(), conversationRefresh]);

  if (!input.conversationId) return;
  const unreadCount = summary.byConversation[input.conversationId] ?? 0;
  if (unreadCount <= 0) return;

  const updatedCount = await input.markRead(input.conversationId);
  input.applyReadState(input.conversationId, updatedCount);
}
