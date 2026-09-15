import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../utils/fileStore";
import { jsonFallbackRuntimePath } from "./jsonFallbackRuntime";

export const messagesStateDataPath = jsonFallbackRuntimePath("messages-state.data.json");
export const notificationStateDataPath = jsonFallbackRuntimePath("notifications-state.data.json");
export const notificationOperationsDataPath = jsonFallbackRuntimePath("notification-operations.data.json");
export const conversationReadJournalPath = jsonFallbackRuntimePath("conversation-read-journal.data.json");
export const notificationBroadcastJournalPath = jsonFallbackRuntimePath("notification-broadcast-journal.data.json");
export const listingLifecycleJournalPath = jsonFallbackRuntimePath("listing-lifecycle.journal.json");

type JsonMessagesState = {
  conversations: unknown[];
  messages: unknown[];
  notificationOutbox: Array<Record<string, unknown>>;
};

type JsonNotificationState = {
  notifications: Array<Record<string, unknown>>;
  preferences: Array<Record<string, unknown>>;
  appliedAggregateEventKeys?: string[];
};

type JsonBroadcastState = {
  broadcasts: Array<{
    id: string;
    cursor: string | null;
    deliveredCount: number;
    status: string;
    updatedAt: string;
  }>;
};

type ConversationReadJournal = {
  messages: JsonMessagesState;
  notifications: JsonNotificationState;
};

export type JsonBroadcastFanoutJournal = {
  version: 2;
  baseMessages: JsonMessagesState;
  baseOperations: JsonBroadcastState;
  outboxEntries: Array<Record<string, unknown>>;
  progress: {
    broadcastId: string;
    expectedCursor: string | null;
    expectedDeliveredCount: number;
    nextCursor: string | null;
    nextDeliveredCount: number;
    nextStatus: string;
    updatedAt: string;
  };
};

export type JsonRecoveryPaths = {
  messages: string;
  notifications: string;
  operations: string;
  conversationJournal: string;
  broadcastJournal: string;
};

export type JsonBroadcastRecoveryPaths = Pick<JsonRecoveryPaths, "messages" | "operations"> & {
  broadcastJournal: string;
};

const defaultPaths: JsonRecoveryPaths = {
  messages: messagesStateDataPath,
  notifications: notificationStateDataPath,
  operations: notificationOperationsDataPath,
  conversationJournal: conversationReadJournalPath,
  broadcastJournal: notificationBroadcastJournalPath,
};

type AtomicWrite = (filePath: string, records: unknown[]) => void;

function defaultWrite(filePath: string, records: unknown[]): void {
  writeJsonArrayFileAtomically(filePath, records);
}

export function recoverConversationReadJournalUnlocked(
  paths: JsonRecoveryPaths = defaultPaths,
  write: AtomicWrite = defaultWrite
): void {
  const journal = readJsonArrayFile<ConversationReadJournal>(paths.conversationJournal)[0];
  if (!journal) return;
  write(paths.messages, [journal.messages]);
  write(paths.notifications, [journal.notifications]);
  write(paths.conversationJournal, []);
}

function sameProgress(
  row: JsonBroadcastState["broadcasts"][number],
  cursor: string | null,
  deliveredCount: number
): boolean {
  return (row.cursor ?? null) === cursor && row.deliveredCount === deliveredCount;
}

export function recoverNotificationBroadcastJournalUnlocked(
  paths: JsonBroadcastRecoveryPaths = defaultPaths,
  write: AtomicWrite = defaultWrite
): void {
  const journal = readJsonArrayFile<JsonBroadcastFanoutJournal>(paths.broadcastJournal)[0];
  if (!journal) return;
  if (journal.version !== 2) {
    throw new Error("Unsupported notification broadcast journal version.");
  }

  const messages = readJsonArrayFile<JsonMessagesState>(paths.messages)[0] ?? structuredClone(journal.baseMessages);
  for (const event of journal.outboxEntries) {
    const dedupeKey = String(event.dedupeKey ?? "");
    if (!messages.notificationOutbox.some((row) => String(row.dedupeKey ?? "") === dedupeKey)) {
      messages.notificationOutbox.push(structuredClone(event));
    }
  }

  const operations = readJsonArrayFile<JsonBroadcastState>(paths.operations)[0] ?? structuredClone(journal.baseOperations);
  const broadcast = operations.broadcasts.find((row) => row.id === journal.progress.broadcastId);
  if (!broadcast) throw new Error("Notification broadcast journal references a missing broadcast.");
  if (sameProgress(broadcast, journal.progress.expectedCursor, journal.progress.expectedDeliveredCount)) {
    broadcast.cursor = journal.progress.nextCursor;
    broadcast.deliveredCount = journal.progress.nextDeliveredCount;
    broadcast.status = journal.progress.nextStatus;
    broadcast.updatedAt = journal.progress.updatedAt;
  } else if (!sameProgress(broadcast, journal.progress.nextCursor, journal.progress.nextDeliveredCount)) {
    if (broadcast.deliveredCount < journal.progress.nextDeliveredCount) {
      throw new Error("Notification broadcast journal progress precondition failed.");
    }
  }

  write(paths.messages, [messages]);
  write(paths.operations, [operations]);
  write(paths.broadcastJournal, []);
}

export function recoverMarketplaceJsonJournalsUnlocked(
  paths: JsonRecoveryPaths = defaultPaths,
  write: AtomicWrite = defaultWrite
): void {
  recoverConversationReadJournalUnlocked(paths, write);
  recoverNotificationBroadcastJournalUnlocked(paths, write);
}

export function commitConversationReadJournalUnlocked(
  messages: JsonMessagesState,
  notifications: JsonNotificationState,
  paths: JsonRecoveryPaths = defaultPaths,
  write: AtomicWrite = defaultWrite
): void {
  const journal: ConversationReadJournal = { messages, notifications };
  write(paths.conversationJournal, [journal]);
  recoverConversationReadJournalUnlocked(paths, write);
}

export function commitNotificationBroadcastJournalUnlocked(
  journal: JsonBroadcastFanoutJournal,
  paths: JsonBroadcastRecoveryPaths = defaultPaths,
  write: AtomicWrite = defaultWrite
): void {
  write(paths.broadcastJournal, [journal]);
  recoverNotificationBroadcastJournalUnlocked(paths, write);
}
