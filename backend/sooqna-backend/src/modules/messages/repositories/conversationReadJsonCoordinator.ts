import * as path from "node:path";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../../utils/fileStore";
import type { Conversation, Message } from "../messages.types";

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

type ConversationReadJournal = {
  messages: PersistedJsonMessagesState;
  notifications: PersistedJsonNotificationState;
};

export const messagesStateDataPath = path.resolve(
  process.cwd(),
  "src/modules/messages/repositories/messages-state.data.json"
);
export const notificationStateDataPath = path.resolve(
  process.cwd(),
  "src/modules/notifications/notifications-state.data.json"
);
const conversationReadJournalPath = path.resolve(
  process.cwd(),
  "src/modules/messages/repositories/conversation-read-journal.data.json"
);

/**
 * A read reconciliation spans two legacy JSON documents. The journal makes a
 * process interruption recoverable by rolling both documents forward to the
 * same completed state before either store is read again.
 */
export function recoverJsonConversationReadUnlocked(): void {
  const journal = readJsonArrayFile<ConversationReadJournal>(conversationReadJournalPath)[0];
  if (!journal) return;
  writeJsonArrayFileAtomically(messagesStateDataPath, [journal.messages]);
  writeJsonArrayFileAtomically(notificationStateDataPath, [journal.notifications]);
  writeJsonArrayFileAtomically(conversationReadJournalPath, []);
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
  const journal: ConversationReadJournal = { messages, notifications };
  writeJsonArrayFileAtomically(conversationReadJournalPath, [journal]);
  writeJsonArrayFileAtomically(messagesStateDataPath, [messages]);
  writeJsonArrayFileAtomically(notificationStateDataPath, [notifications]);
  writeJsonArrayFileAtomically(conversationReadJournalPath, []);
}
