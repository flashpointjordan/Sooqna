# In-app Notification System Design

Date: 2026-08-24
Status: Approved for specification

## Goal

Add a reliable, real-time, in-app notification system to Sooqna. Signed-in users receive a header bell, unread counter, rich popover, full notification center, and per-category preferences. The first release does not send email, mobile push, or browser push notifications.

## Product scope

### Included notification categories

1. **Messages**
   - A participant receives a notification when another participant sends a message.
   - The notification contains the sender name, listing title, and a short sanitized preview, not the full private message.

2. **Listings**
   - Listing approved.
   - Listing rejected, including a safe rejection summary when available.
   - Listing approaching expiration.
   - Listing expired.

3. **Engagement**
   - Listing favorites aggregated by listing and time bucket.
   - Review received.

4. **Saved searches**
   - Newly published listings matching a saved search, aggregated by saved search and time bucket.

5. **System and administration**
   - System announcements targeted to all users, a role, or explicit users.
   - Security/account notifications. These are mandatory and cannot be disabled.

### Excluded from the first release

- Email delivery.
- Browser Web Push or mobile push.
- SMS or WhatsApp.
- User-authored marketing campaigns.
- Real-time chat transport over WebSocket; the existing messaging flow remains separate.
- Redis or a distributed event bus while the backend remains a single PM2 process.

## User experience

### Header bell and rich popover

The authenticated header displays a bell with a capped unread badge (`99+`). Opening the popover fetches the latest notifications and shows:

- **All** and **Unread** tabs.
- The latest eight items.
- Category icon, title, short body, relative time, and unread marker.
- Actions for marking all as read and opening notification preferences.
- A link to the full notification center.

Clicking a notification marks it read and navigates to its validated internal action URL. Keyboard navigation, visible focus, `aria-live` updates for the counter, Escape-to-close, and RTL layout are required.

### Full notification center

The `/notifications` page uses the approved layout:

- Desktop category sidebar; horizontal filter chips on mobile.
- All/unread filters.
- Date groups such as Today, Yesterday, and Earlier.
- Cursor-based infinite pagination or an explicit “Load more” control.
- Mark one or all as read.
- Soft-delete one notification.
- Loading skeleton, empty state, offline/reconnecting state, recoverable error state, and retry action.

### Preferences

The account settings area exposes toggles for Messages, Listings, Engagement, and Saved Searches. System and Security appear enabled and locked with an explanation. New accounts default to all optional categories enabled.

## Notification taxonomy

Prisma enums define stable values:

```text
NotificationCategory:
  MESSAGES
  LISTINGS
  ENGAGEMENT
  SAVED_SEARCHES
  SYSTEM
  SECURITY

NotificationType:
  MESSAGE_RECEIVED
  LISTING_APPROVED
  LISTING_REJECTED
  LISTING_EXPIRING
  LISTING_EXPIRED
  LISTING_FAVORITED_AGGREGATE
  REVIEW_RECEIVED
  SAVED_SEARCH_MATCHES
  SYSTEM_ANNOUNCEMENT
  SECURITY_ALERT
```

Types determine templates, category, icon, mandatory status, and allowed action URL shape. Clients render known types through a type-to-presentation mapping and use a safe generic fallback for future unknown types.

## Data model

### Notification

One row represents one user's visible notification:

- `id`: cuid primary key.
- `userId`: Firebase UID, related to `User.firebaseUid`, cascade delete.
- `type`: `NotificationType`.
- `category`: `NotificationCategory`.
- `title`: short server-generated Arabic text.
- `body`: short server-generated Arabic text.
- `actionUrl`: nullable internal relative URL.
- `entityType` and `entityId`: nullable source reference.
- `metadata`: small JSON object containing only presentation-safe values.
- `dedupeKey`: nullable unique key for idempotent creation.
- `aggregationKey`: nullable key used to update a current aggregate.
- `readAt`: nullable timestamp.
- `deletedAt`: nullable soft-delete timestamp.
- `expiresAt`: retention cutoff.
- `createdAt` and `updatedAt`.

Indexes support `(userId, deletedAt, createdAt)`, `(userId, readAt, deletedAt)`, and `(aggregationKey, createdAt)`. Every list/count query excludes soft-deleted and expired rows.

### NotificationPreference

- `id`: cuid primary key.
- `userId`: Firebase UID.
- `category`: `NotificationCategory`.
- `enabled`: boolean.
- `createdAt` and `updatedAt`.
- Unique constraint on `(userId, category)`.

Missing optional-category rows mean enabled. SYSTEM and SECURITY ignore stored disabled values and always resolve to enabled.

### NotificationOutbox

The durable outbox records domain events before delivery:

- `id`, `eventType`, `aggregateType`, and `aggregateId`.
- `recipientId` when known.
- `payload` containing validated event data.
- globally unique `dedupeKey`.
- state: `PENDING`, `PROCESSING`, `PROCESSED`, `FAILED`, or `DEAD`.
- `attempts`, `availableAt`, `processedAt`, `lastError`, `createdAt`, and `updatedAt`.

Business mutations create an outbox row in the same Prisma transaction as the successful domain change whenever that module already owns a transaction. Where a legacy operation cannot yet share a transaction, it writes an idempotent outbox event immediately after success and logs a structured error if that write fails; those specific boundaries receive integration tests and monitoring.

### NotificationBroadcast

Administrative fan-out uses a durable broadcast row with audience (`ALL`, roles, or explicit user IDs), template fields, action URL, status, and a pagination cursor. The worker creates per-user notifications in bounded batches and can resume after restart without duplicating rows.

## Backend architecture

Create `src/modules/notifications/` using the established route → controller → service → repository layering.

### Notification service responsibilities

- Validate and create typed notifications.
- Resolve user preferences.
- Apply mandatory-category rules.
- Enforce idempotency through `dedupeKey`.
- Aggregate favorites and saved-search matches.
- List and count only the authenticated user's active notifications.
- Mark one/all as read and soft-delete with ownership checks.
- Publish a lightweight real-time signal only after persistence succeeds.

### Event producers

Existing services enqueue typed outbox events after successful actions:

- `MessagesService.createMessage` → `MESSAGE_RECEIVED` for every participant except the sender.
- Listing moderation/publish lifecycle → approved or rejected events.
- Expiration job → expiring and expired events with deterministic daily dedupe keys.
- Favorite creation → favorite aggregate event for the listing owner, excluding self-favorites.
- Review creation → review received event for the seller.
- Published listing → saved-search matching event.
- Admin route → durable broadcast.

Event producers provide IDs and facts, not final copy. Notification templates remain centralized in the notification module.

### Aggregation

Favorites use an hourly key such as `favorite:{listingId}:{ownerId}:{UTC-hour}`. Repeated events update one notification's count and body rather than creating new rows.

Saved-search matches use `saved-search:{savedSearchId}:{userId}:{UTC-hour}`. Metadata stores a capped list of matching listing IDs plus a total count; the action URL opens the saved query. Matching reuses the canonical listing-search normalization and filters so alerts do not disagree with search results.

### Worker

A backend worker claims ready outbox rows in bounded batches using an atomic database claim (`FOR UPDATE SKIP LOCKED` or an equivalent atomic update). It validates payloads, creates/updates notifications, marks events processed, and publishes SSE signals.

Failures use exponential backoff with jitter. After a fixed maximum of eight attempts, the row becomes `DEAD` and produces a structured error log. A process restart safely resumes pending/failed rows. Graceful shutdown stops claiming new work and allows the active batch to finish within a bounded timeout.

## API design

All user routes require a valid Firebase token, current active user, and verified email in line with existing protected features.

```text
GET    /api/notifications?cursor=&limit=&category=&unread=
GET    /api/notifications/unread-count
PATCH  /api/notifications/:notificationId/read
POST   /api/notifications/read-all
DELETE /api/notifications/:notificationId
GET    /api/notifications/preferences
PUT    /api/notifications/preferences
GET    /api/notifications/stream

POST   /api/admin/notification-broadcasts
GET    /api/admin/notification-broadcasts
```

List pagination uses an opaque cursor based on `(createdAt, id)` and a maximum page size of 50. Mutations are idempotent: reading an already-read item and deleting an already-deleted item succeed without changing another user's data.

Action URLs must be relative application paths selected by server templates. Arbitrary external URLs, `javascript:` URLs, and user-supplied redirects are rejected.

## Real-time delivery

The web client opens an SSE-compatible streamed `fetch` request so it can send `Authorization: Bearer <Firebase ID token>`. Tokens never appear in URLs or logs.

The backend response uses `text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no`. It emits heartbeat comments approximately every 25 seconds.

Events contain no notification body or private content:

```json
{
  "event": "notification.changed",
  "notificationId": "...",
  "unreadCount": 4,
  "version": 1
}
```

The client treats REST/PostgreSQL as the source of truth and refetches the count/latest page after a signal. On disconnect it reconnects with exponential backoff and jitter capped at 30 seconds. On successful reconnection it refetches to recover missed events.

The stream opens only for a signed-in user while the document is visible. Hidden tabs close the stream and refetch on visibility restore. The backend caps concurrent streams per user and cleans up listeners on abort/close. The stream endpoint has a connection-attempt limiter separate from ordinary REST rate limits; an open stream is not counted as repeated API requests.

The first release uses an in-memory connection registry because production runs one backend PM2 process. Moving to multiple backend instances requires Redis Pub/Sub or another shared broker; REST recovery continues to guarantee eventual UI consistency.

## Frontend architecture

- `NotificationProvider`: authenticated lifecycle, initial unread fetch, stream connection, reconnection, and shared state.
- `notificationService`: typed REST calls and streaming parser.
- `NotificationBell`: accessible badge/button.
- `NotificationPopover`: approved rich popover with All/Unread tabs and latest eight items.
- `/notifications`: full center with category filters and cursor pagination.
- `NotificationItem`: shared rendering, click-to-read/navigation, menu actions.
- `NotificationPreferences`: account settings toggles.
- Type-to-presentation mapping: icon, color, accessible label, and fallback.

Read/delete operations update the UI optimistically, then roll back and show a recoverable Arabic error if the request fails. The unread count is always reconciled with the server response after mutations or reconnects.

## Security and privacy

- Repository queries always include the authenticated `userId`; controllers never accept a user ID for ordinary user routes.
- SSE signals contain identifiers and counts only.
- Message previews are sanitized, length-capped, and never included in structured logs.
- Metadata schemas are defined per notification type and reject unknown sensitive fields.
- Logs contain event type, notification ID, outbox ID, attempt, and outcome, but no body, token, email, or message content.
- Admin broadcasts require ADMIN role and create audit-log entries.
- REST writes have conservative per-user rate limits; admin broadcast routes retain stricter admin limits.

## Retention and cleanup

Notifications expire 90 days after creation. A daily cleanup job permanently deletes expired or user-soft-deleted notifications in bounded batches. Processed outbox rows are retained for 14 days for diagnostics; dead rows are retained for 30 days. Cleanup is idempotent and does not run as a database migration.

## Failure behavior

- A disconnected stream degrades to stale-but-usable UI; REST refresh and reconnection recover it.
- A failed outbox event retries without repeating the business mutation.
- Duplicate domain events resolve through unique dedupe keys.
- Unknown notification types render a generic safe item rather than breaking the list.
- A failed preference read uses default-enabled optional categories and surfaces a settings warning.
- If notification creation fails permanently, the core marketplace action remains completed and operations receive a dead-letter diagnostic.

## Testing strategy

### Backend

- Prisma migration and schema constraints.
- Template mapping for every notification type.
- Preference resolution and mandatory categories.
- Ownership for list/read/delete routes.
- Cursor ordering and pagination boundaries.
- Idempotent dedupe behavior.
- Favorite and saved-search aggregation.
- Outbox claim, retry, dead-letter, and restart behavior.
- Event producer integration for messages, listings, favorites, reviews, saved searches, and broadcasts.
- SSE authentication, headers, heartbeat, signal shape, client cleanup, and connection caps.
- Admin authorization and audit logging.

### Frontend

- Stream parsing, backoff, visibility behavior, and REST recovery.
- Badge count reconciliation.
- Popover tabs, mark-all, click-to-read, and error rollback.
- Notification center filtering, pagination, empty/loading/error states, and mobile layout.
- Preference toggles and locked mandatory categories.
- Accessibility checks for keyboard navigation, focus, labels, and live-region announcements.

### End-to-end

At minimum, Playwright covers a new message producing a notification, opening the bell, marking the item read, and navigating to the conversation. A second flow covers listing moderation producing an owner notification.

## Observability

Structured metrics/logs cover outbox queue depth, oldest pending age, processed/failed/dead counts, notification creation by type, active SSE connections, reconnect/close reasons, and cleanup counts. Health output exposes only aggregate status, never notification content or user identifiers.

## Rollout

1. Deploy additive database migration and backend models.
2. Deploy notification module, event producers, worker, and REST APIs with the UI still absent.
3. Verify outbox processing and ownership in production.
4. Deploy the provider, bell, popover, center, and preferences.
5. Enable SSE after confirming Nginx buffering is disabled for the stream route.
6. Monitor queue age, errors, connection counts, and rate limits.

Rollback disables event production, the worker, and UI entry points while leaving additive tables intact. No destructive schema rollback is required.
