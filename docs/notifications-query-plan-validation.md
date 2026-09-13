# Notification and message read-query plan validation

## Current status (2026-09-12)

No query-plan result is claimed in this change. The workspace contains only the
placeholder `DATABASE_URL` in `.env.example`; both `STAGING_DATABASE_URL` and
`DATABASE_URL` were absent from the execution environment. Therefore no safe,
representative staging database was available for `EXPLAIN (ANALYZE, BUFFERS)`.

## Reproducible staging check

Use `backend/sooqna-backend/scripts/explain-conversation-read-queries.sql` from
the backend directory. Supply a staging-only connection plus all four required
psql variables:

- `reader_id`: a real participant who will mark the conversation read;
- `recipient_id`: the recipient used by the delayed message projection lookup;
- `conversation_id`: a representative conversation owned by both selected users; and
- `message_id`: a message in that conversation addressed to `recipient_id`.

Independently verify that the connection target is a disposable staging clone,
then run with `ON_ERROR_STOP` so any missing variable or failed plan aborts the
transaction:

```powershell
if ([string]::IsNullOrWhiteSpace($env:STAGING_DATABASE_URL)) {
  throw 'STAGING_DATABASE_URL is required; do not substitute DATABASE_URL.'
}

psql --set ON_ERROR_STOP=1 --dbname $env:STAGING_DATABASE_URL `
  -v reader_id='representative-reader-uid' `
  -v recipient_id='representative-recipient-uid' `
  -v conversation_id='representative-conversation-id' `
  -v message_id='representative-message-id' `
  -f scripts/explain-conversation-read-queries.sql
```

The script captures seven plans. The two update plans execute inside a
transaction that always ends with `ROLLBACK`; the script must never be run
against production.

The seven plans are, in execution order:

1. acquire the shared `conversation:<id>` transaction advisory lock;
2. revalidate and row-lock the reader's participant record;
3. look up the authoritative message/read state and recipient ownership used by
   delayed `MESSAGE_RECEIVED` projection;
4. mark the reader's eligible conversation messages read, retaining participant
   ownership in the update predicate;
5. mark the reader's active message notifications for that conversation read;
6. aggregate unread messages across conversations owned by the reader; and
7. count all active unread notifications owned by the reader.

## Required evidence before approval

Capture all seven complete plans plus relevant table cardinalities. Confirm:

- the advisory-lock plan completes on the exact `conversation:<conversation_id>` key;
- the ownership row lock uses
  `ConversationParticipant_conversationId_userId_key` without scanning the participant table;
- the delayed projection uses the `Message` primary key and the participant ownership index;
- `messages_unread_lookup_idx` is used for the conversation-scoped message update,
  together with indexed participant ownership;
- `notifications_message_read_lookup_idx` is used for the owned active
  message-notification update;
- the unread message aggregate uses the message composite together with a
  participant ownership index;
- the notification unread total uses `Notification_userId_readAt_deletedAt_idx`;
- no full-table sequential scan occurs at representative volume; and
- estimated and actual row counts are reasonably aligned, and buffer reads stay
  proportionate to the reader's owned unread rows.

If PostgreSQL selects a sequential scan for a deliberately tiny staging table,
load a production-like anonymized volume and rerun before changing indexes.
