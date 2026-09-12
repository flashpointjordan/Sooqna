-- Run only against a staging clone with representative production-like volume.
-- Example:
--   psql "$STAGING_DATABASE_URL" -v reader_id='firebase-uid' -v conversation_id='conv-id' \
--     -f scripts/explain-conversation-read-queries.sql
--
-- UPDATE plans execute under EXPLAIN ANALYZE, so this script wraps them in a
-- transaction and always rolls them back. Never point it at production.

BEGIN;

EXPLAIN (ANALYZE, BUFFERS)
UPDATE "Message"
SET "isRead" = true, "readAt" = clock_timestamp()
WHERE "conversationId" = :'conversation_id'
  AND "senderId" <> :'reader_id'
  AND "isRead" = false
  AND "deletedAt" IS NULL;

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

ROLLBACK;
