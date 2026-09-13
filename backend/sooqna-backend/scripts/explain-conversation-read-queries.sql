-- Run only against a staging clone with representative production-like volume.
-- Example:
--   psql "$STAGING_DATABASE_URL" -v reader_id='firebase-uid' -v recipient_id='firebase-uid' \
--     -v conversation_id='conv-id' -v message_id='message-id' \
--     -f scripts/explain-conversation-read-queries.sql
--
-- UPDATE plans execute under EXPLAIN ANALYZE, so this script wraps them in a
-- transaction and always rolls them back. Never point it at production.

BEGIN;

-- The production repository serializes send, read reconciliation, and delayed
-- message-notification projection on this exact transaction-scoped key.
EXPLAIN (ANALYZE, BUFFERS)
SELECT pg_advisory_xact_lock(hashtextextended('conversation:' || :'conversation_id', 0));

-- Ownership is revalidated after acquiring the conversation lock and before
-- either message or notification rows can be changed.
EXPLAIN (ANALYZE, BUFFERS)
SELECT "id"
FROM "ConversationParticipant"
WHERE "conversationId" = :'conversation_id'
  AND "userId" = :'reader_id'
FOR SHARE;

-- The delayed worker uses this authoritative message/ownership lookup while
-- holding the same advisory lock before creating the notification projection.
EXPLAIN (ANALYZE, BUFFERS)
SELECT message."id", message."isRead", message."readAt", message."deletedAt"
FROM "Message" AS message
WHERE message."id" = :'message_id'
  AND message."conversationId" = :'conversation_id'
  AND message."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "ConversationParticipant" AS participant
    WHERE participant."conversationId" = message."conversationId"
      AND participant."userId" = :'recipient_id'
  );

EXPLAIN (ANALYZE, BUFFERS)
UPDATE "Message"
SET "isRead" = true, "readAt" = clock_timestamp()
WHERE "conversationId" = :'conversation_id'
  AND "senderId" <> :'reader_id'
  AND "isRead" = false
  AND "deletedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "ConversationParticipant" AS participant
    WHERE participant."conversationId" = "Message"."conversationId"
      AND participant."userId" = :'reader_id'
  );

EXPLAIN (ANALYZE, BUFFERS)
UPDATE "Notification"
SET "readAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
WHERE "userId" = :'reader_id'
  AND "type" = 'MESSAGE_RECEIVED'::"NotificationType"
  AND "entityType" = 'conversation'
  AND "entityId" = :'conversation_id'
  AND "readAt" IS NULL
  AND "deletedAt" IS NULL
  AND "expiresAt" > CURRENT_TIMESTAMP;

EXPLAIN (ANALYZE, BUFFERS)
SELECT message."conversationId", COUNT(*)
FROM "Message" AS message
WHERE message."senderId" <> :'reader_id'
  AND message."isRead" = false
  AND message."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "ConversationParticipant" AS participant
    WHERE participant."conversationId" = message."conversationId"
      AND participant."userId" = :'reader_id'
  )
GROUP BY message."conversationId";

EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*)
FROM "Notification"
WHERE "userId" = :'reader_id'
  AND "readAt" IS NULL
  AND "deletedAt" IS NULL
  AND "expiresAt" > CURRENT_TIMESTAMP;

ROLLBACK;
