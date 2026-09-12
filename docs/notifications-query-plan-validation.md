# Notification and message read-query plan validation

## Current status (2026-09-12)

No query-plan result is claimed in this change. The workspace contains only the
placeholder `DATABASE_URL` in `.env.example`; both `STAGING_DATABASE_URL` and
`DATABASE_URL` were absent from the execution environment. Therefore no safe,
representative staging database was available for `EXPLAIN (ANALYZE, BUFFERS)`.

## Reproducible staging check

Use `backend/sooqna-backend/scripts/explain-conversation-read-queries.sql` from
the backend directory. Supply a staging-only connection, a real participant UID,
and one conversation containing representative unread volume:

```powershell
psql $env:STAGING_DATABASE_URL `
  -v reader_id='representative-reader-uid' `
  -v conversation_id='representative-conversation-id' `
  -f scripts/explain-conversation-read-queries.sql
```

The script executes the two update plans inside a transaction and ends with
`ROLLBACK`; it must never be run against production.

## Required evidence before approval

Capture the complete three plans plus table cardinalities. Confirm:

- `messages_unread_lookup_idx` is used for the conversation-scoped message update;
- `notifications_message_read_lookup_idx` is used for the owned active message-notification update;
- the unread aggregate uses the message composite together with the participant ownership index;
- no full-table sequential scan occurs at representative volume; and
- actual row counts and buffer reads stay proportionate to the reader's owned unread rows.

If PostgreSQL selects a sequential scan for a deliberately tiny staging table,
load a production-like anonymized volume and rerun before changing indexes.
