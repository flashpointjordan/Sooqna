-- The unread composite starts with conversationId, so the original single-column
-- index is redundant for conversation message reads and listing.
DROP INDEX IF EXISTS "Message_conversationId_idx";

-- Supports ownership-scoped reconciliation of active message notifications.
CREATE INDEX "notifications_message_read_lookup_idx"
ON "Notification"("userId", "type", "entityType", "entityId", "readAt", "deletedAt", "expiresAt");
