import { readJsonArrayFile } from "../../../utils/fileStore";
import type { Conversation, Message } from "../messages.types";
import {
  commitConversationReadJournalUnlocked,
  messagesStateDataPath,
  notificationStateDataPath,
  recoverMarketplaceJsonJournalsUnlocked,
} from "../../../shared/database/marketplaceJsonRecovery";

export { messagesStateDataPath, notificationStateDataPath };

export type PersistedJsonMessagesState = {
  conversations: Conversation[];
  messages: Message[];
  notificationOutbox: Array<Record<string, unknown>>;
};

export type PersistedJsonNotification = {
  id: string;
  userId: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | string | null;
  deletedAt: Date | string | null;
  expiresAt: Date | string;
  updatedAt: Date | string;
  [key: string]: unknown;
};

export type PersistedJsonNotificationState = {
  notifications: PersistedJsonNotification[];
  preferences: Array<Record<string, unknown>>;
  appliedAggregateEventKeys?: string[];
};

/**
 * A read reconciliation spans two legacy JSON documents. The journal makes a
 * process interruption recoverable by rolling both documents forward to the
 * same completed state before either store is read again.
 */
export function recoverJsonConversationReadUnlocked(): void {
  recoverMarketplaceJsonJournalsUnlocked();
}

export function readJsonNotificationStateUnlocked(): PersistedJsonNotificationState {
  recoverJsonConversationReadUnlocked();
  return (
    readJsonArrayFile<PersistedJsonNotificationState>(notificationStateDataPath)[0] ?? {
      notifications: [],
      preferences: [],
      appliedAggregateEventKeys: [],
    }
  );
}

export function commitJsonConversationReadUnlocked(
  messages: PersistedJsonMessagesState,
  notifications: PersistedJsonNotificationState
): void {
  commitConversationReadJournalUnlocked(messages, notifications);
}
