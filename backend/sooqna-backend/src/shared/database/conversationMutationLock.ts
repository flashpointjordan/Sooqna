import { Prisma } from "@prisma/client";
import type { TransactionContext } from "./unitOfWork";

export function conversationMutationLockKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Serializes message send, read reconciliation, and message-notification projection. */
export async function lockConversationMutation(
  tx: TransactionContext,
  conversationId: string
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${conversationMutationLockKey(conversationId)}, 0))`
  );
}
