# Main Consolidation and Complete Notification System Design

**Date:** 2026-09-11  
**Status:** Approved design  
**Canonical branch:** `main`

## Goal

Consolidate every useful repository change onto `main`, complete Sooqna's messaging and in-app notification experience from persistence through user interface and production operations, make `Dev` and `Master` exact mirrors of the verified `main`, and remove all other branches only after their useful work is preserved and production is healthy.

## Success Definition

The work is complete when all of the following are true:

1. A message sent by user A to user B is persisted exactly once.
2. User B sees a red message badge from any page without first opening `/messages`.
3. User B receives a durable in-app notification and a real-time UI signal without private message content being exposed in the signal or logs.
4. Opening the target conversation marks its messages and corresponding message notifications read and reconciles all visible counters.
5. Listing, engagement, saved-search, system, and security events produce durable notifications with correct ownership and preferences.
6. The notification bell, popover, full center, preferences, bottom navigation badge, loading states, error states, reconnection states, and accessibility behavior are implemented.
7. Backend, frontend, integration, migration, and end-to-end checks pass on the exact commit deployed to production.
8. Production health, notification worker health, queue age, and the two-account message flow are verified.
9. `main`, `Dev`, and `Master` point to the same verified commit locally and on `origin`.
10. All other local and remote branches are deleted after recoverable archive tags are created and pushed.

## Current Repository Findings

### Branch inventory

| Branch | Relationship to `main` | Decision |
|---|---:|---|
| `main` | Canonical baseline | Keep and build here through an isolated integration worktree |
| `Dev` | 14 commits behind, no unique commits | Fast-forward or safely realign to final `main` |
| `Master` | 14 commits behind, no unique commits | Fast-forward or safely realign to final `main` |
| `softshop` | 14 behind, 4 commits ahead | Preserve only useful local documentation/worktree-ignore changes; reject the obsolete softshop deployment workflow |
| `origin/softshop` | One unique deployment commit | Do not merge because production is intentionally `main`-driven |
| `codex/rate-limit-proxy-fix` | Mostly patch-equivalent to `main`; one useful unique commit | Port `4c75e6f` (`fix: trust production proxy addresses`) |
| `codex/notification-system` | 24 commits ahead of `main` | Integrate its backend foundation, then complete and harden it before release |
| `origin/codex/admin-product-analytics-enhancements` | No unique commits relative to `main` | Delete after archive tag and verification |

### Worktree and uncommitted-state inventory

The primary `softshop` worktree contains user-owned documentation cleanup changes and untracked documentation/memory files. The notification worktree contains an untracked `notifications.producers.test.ts` that exposes missing event-producer integration. These changes must be preserved before any branch or worktree removal.

No destructive branch cleanup may begin while any worktree is dirty or while an untracked file exists only in a worktree scheduled for removal.

### Product state

- Messaging persistence and unread-message calculation exist.
- The account dashboard fetches unread messages once when opened and converts fetch failure to zero.
- The mobile messages navigation item has no unread state or badge.
- Message polling is limited to the messages workspace; the rest of the application has no global unread lifecycle.
- `main` includes safer 30-second, visible-tab, single-flight polling and correct retry semantics for message writes.
- The notification branch contains schema, REST APIs, preferences, templates, outbox worker, and SSE broker foundations.
- The notification branch has no frontend implementation and no production event-producer wiring.
- The notification test run currently reports 83 passing and 5 failing tests; the failures cover missing message, favorite, and review producer integration.

## Chosen Integration Strategy

Use a **main-first, selected-integration strategy** rather than merging every branch wholesale or squashing all history.

1. Fetch and record the current remote state.
2. Create immutable annotated archive tags for every branch head that will later be deleted.
3. Preserve dirty worktree changes on dedicated temporary preservation commits or patches with an explicit manifest.
4. Create a clean isolated worktree from current `main` for integration.
5. Port the unique production proxy fix.
6. Integrate the notification foundation in its existing commit order to retain security and reliability fixes.
7. Bring the untracked producer integration test into the integration line and make it the first failing test for producer work.
8. Complete backend producers, synchronization, frontend, tests, documentation, and operations on the integration line.
9. Merge the verified integration line into `main` without rewriting published `main` history.
10. Push and deploy `main`; verify production before branch realignment or deletion.
11. Make `Dev` and `Master` exact mirrors of the verified `main` using `--force-with-lease` only if a normal fast-forward is impossible.
12. Remove obsolete worktrees, then local and remote noncanonical branches.

The softshop-only deployment workflow is intentionally excluded. The existing main deployment workflow remains the only production path.

## Git Safety and Recovery Design

### Archive tags

Before deletion, create annotated tags using the form:

```text
archive/2026-09-11/<normalized-branch-name>
```

Tags are created for `softshop`, `origin/softshop`, `codex/rate-limit-proxy-fix`, `codex/notification-system`, and `origin/codex/admin-product-analytics-enhancements`. Tags are pushed before remote branch deletion and retained for at least 30 days. They preserve recoverability without leaving active development branches.

### Dirty worktree preservation

Every dirty path is classified as one of:

- intended product/documentation work to integrate;
- generated or obsolete material to exclude;
- user-owned work requiring preservation but outside this feature.

No item is discarded implicitly. Intended changes are committed on a temporary preservation branch and cherry-picked selectively. Excluded files are listed in the consolidation report with a reason. User-owned unrelated work remains recoverable from a preservation commit and archive tag.

### Branch deletion gate

Branches may be deleted only after:

- their archive tags exist locally and remotely;
- `git cherry` and tree comparisons confirm useful changes are present or explicitly rejected;
- all associated worktrees are clean and removed with Git's worktree command;
- production is healthy on the final `main` commit;
- `Dev` and `Master` match final `main` locally and remotely.

## Notification Domain Architecture

### Durable source of truth

PostgreSQL remains the durable source of truth. Notifications are never derived solely from client state or an in-memory event. The existing notification models are retained and reviewed:

- `Notification`: one visible item for one user;
- `NotificationPreference`: optional-category controls per user;
- `NotificationOutbox`: durable domain-event delivery;
- `NotificationBroadcast`: resumable administrative fan-out.

System and security notifications are mandatory. Missing preference rows mean enabled for optional categories.

### Supported categories and event types

The first complete release supports:

- Messages: `MESSAGE_RECEIVED`.
- Listings: approved, rejected, expiring, and expired.
- Engagement: favorite aggregate and review received.
- Saved searches: newly published matching listings, aggregated by saved search and time bucket.
- System: administrator announcements.
- Security: mandatory account/security alerts.

### Atomic domain-event production

Whenever the domain mutation already uses or can safely adopt a Prisma transaction, the business write and outbox write occur in the same transaction. This includes message creation, conversation last-message update, and the message notification outbox rows.

Where legacy module boundaries cannot yet share a transaction, the module performs an idempotent outbox upsert immediately after the successful business operation. Failure does not roll back an already successful user action, but it produces a structured error with event type, aggregate ID, recipient ID, and outcome and is covered by an integration test.

### Message event flow

```text
Sender submits message
  -> authenticate, authorize, validate, and content-filter
  -> transaction inserts Message
  -> transaction updates Conversation last-message fields
  -> transaction inserts one MESSAGE_RECEIVED outbox row per non-sender participant
  -> response returns exactly one persisted message
  -> worker claims outbox rows
  -> worker applies preferences and dedupe
  -> worker persists notifications
  -> broker emits content-free notification.changed signal
  -> authenticated clients refetch canonical counts and latest items
```

Message previews are normalized, secret-like fragments are removed, email-like content is removed, and the remaining preview is capped. Full private messages never appear in SSE payloads, structured logs, or notification metadata.

### Read-state synchronization

Message unread state and notification unread state serve different UI purposes but must not diverge visibly:

- the bottom navigation messages badge reflects unread messages;
- the header bell reflects unread notifications across all categories;
- the notification popover may show an unread message notification even when the user has not opened the conversation;
- marking a conversation read also marks active `MESSAGE_RECEIVED` notifications for that user and conversation read;
- opening a message notification marks the notification read, navigates to the conversation, and the conversation-read operation reconciles message unread state;
- all mutation responses return canonical counts used to replace optimistic client counts.

The current global `Message.isRead` representation is acceptable only while conversations are strictly one-to-one. Group conversations require a separate per-recipient message receipt model and are outside this release.

### Worker and delivery guarantees

The worker retains atomic batch claiming, retry with exponential backoff and jitter, a maximum of eight attempts, `DEAD` state diagnostics, restart recovery, and bounded graceful shutdown. Dedupe keys guarantee at-most-one visible result per logical direct event. Favorite and saved-search aggregates update a current bucket rather than generating notification floods.

The worker is started only by the production server process, not by tests, migrations, one-off scripts, or Prisma generation.

## Backend API Design

Authenticated, active, verified users receive:

```text
GET    /api/notifications?cursor=&limit=&category=&unread=
GET    /api/notifications/unread-counts
PATCH  /api/notifications/:notificationId/read
POST   /api/notifications/read-all
DELETE /api/notifications/:notificationId
GET    /api/notifications/preferences
PUT    /api/notifications/preferences
GET    /api/notifications/stream
```

`unread-counts` returns the total and per-category counts so the bell and category UI reconcile from one canonical response. The existing message unread-summary endpoint remains the source for the bottom messages badge.

Administrative broadcast APIs require `ADMIN`, validate internal action URLs, create audit records, paginate recipients in bounded batches, and resume without duplicates.

All repository mutations include the authenticated user ID in the ownership predicate. Reading or deleting another user's notification returns not found without revealing existence.

## Frontend Architecture

### Global provider

`NotificationProvider` is mounted inside the authenticated application shell and owns:

- initial notification unread-count fetch;
- initial message unread-summary fetch;
- latest notification page cache;
- SSE lifecycle and stream parser;
- exponential reconnect backoff with jitter;
- visibility-aware connect/disconnect;
- REST reconciliation after connection, reconnection, read, delete, and mark-all actions;
- a low-frequency polling fallback when the stream is unavailable;
- an event hook that asks the messages workspace to refresh when a message-category signal arrives.

The provider resets all private state immediately on logout or authenticated-user change.

### Header and mobile navigation

- Authenticated desktop/header UI displays an accessible notification bell.
- The bell badge displays `1` through `99` and `99+` above that.
- Mobile bottom navigation displays a red message badge based on unread messages, not total notification count.
- Badges use `aria-live="polite"` text that announces meaningful count changes without repeating on every render.
- No badge is rendered for signed-out users.

### Notification popover

The popover provides All and Unread tabs, the latest eight items, category presentation, title, safe body, relative time, unread marker, mark-all, settings, and full-center navigation. It supports keyboard traversal, visible focus, Escape-to-close, outside-click close, and RTL layout.

### Full notification center

`/notifications` provides category filters, all/unread selection, date grouping, opaque cursor pagination, mark one/all read, soft-delete, loading skeleton, empty state, offline/reconnecting state, recoverable error state, and retry.

### Preferences

Account settings exposes toggles for Messages, Listings, Engagement, and Saved Searches. System and Security are visibly enabled and locked with an explanation. Failed preference reads surface a warning instead of silently presenting defaults as saved state.

### Messaging experience improvements

- Sending messages show pending, sent, failed, and retry states.
- Offline messages flush on the browser `online` event and on authenticated application startup.
- The client uses a stable local idempotency key so an ambiguous retry cannot duplicate a message.
- The messages workspace keeps its safe single-flight refresh behavior.
- A message notification signal triggers an immediate inbox/active-conversation refresh when appropriate.
- Account-dashboard count failures render an unavailable/error state, never a false zero.
- Arabic copy uses consistent labels such as `الرسائل`, `لا توجد رسائل بعد`, and `رسالة جديدة من …`.

## Real-Time Transport

The first release uses authenticated streamed `fetch` over SSE because the Firebase bearer token must remain in the Authorization header. The URL contains no token. Events include only notification ID, unread counts, category, and protocol version.

The backend emits heartbeats, disables proxy buffering, caps concurrent streams per user, removes listeners on disconnect, and closes streams during graceful shutdown. The client closes the stream while the tab is hidden and reconciles through REST when visibility returns.

Production currently assumes one backend process. Before moving to multiple PM2 instances, the broker must move to Redis Pub/Sub or another shared transport. REST reconciliation remains required even after that change.

## Performance Design

- Replace message unread row loading and JavaScript reduction with database-side grouping or a recipient-oriented aggregate query.
- Add and validate composite indexes for unread-message and notification list/count predicates.
- Keep notification pages cursor-based with a maximum limit of 50.
- Cap message previews, metadata arrays, broadcast batches, worker claim batches, and cleanup batches.
- Avoid polling while tabs are hidden and prevent concurrent refresh cycles.
- Measure query plans with representative unread-message and notification volumes before production rollout.

## Error Handling

- Core marketplace mutations do not fail merely because a post-commit notification signal cannot be published.
- Transactional outbox failures do fail and roll back the associated transaction, preventing an invisible half-write.
- Nontransactional compatibility boundaries log structured enqueue failures without message body, email, token, or credentials.
- Client optimistic read/delete operations roll back on API failure and show actionable Arabic feedback.
- SSE failure degrades to polling and displays reconnecting state without blocking navigation.
- Unknown notification types render a safe generic item.
- Rate-limit responses preserve status, application code, and `Retry-After`; writes are never automatically replayed without idempotency.

## Security and Privacy

- Controllers derive identity from verified Firebase authentication context.
- User IDs are not accepted from ordinary notification clients.
- Action URLs are validated internal relative routes.
- Notification metadata is allowlisted per event type.
- Private message content, tokens, authorization headers, email addresses, and credentials are excluded from logs and SSE.
- Admin broadcasts require role authorization, validation, rate limiting, and audit logging.
- Notification preference changes and notification mutations have conservative per-user write limits.
- Retention cleanup permanently removes expired and soft-deleted notifications in bounded, idempotent batches.

## Testing Strategy

### Git consolidation checks

- Record branch heads, merge bases, `git cherry` output, tree differences, worktree status, and archive tags.
- Verify the proxy fix and notification foundation are present in final `main`.
- Verify excluded softshop deployment files are absent.
- Verify no deleted branch contains an unclassified unique patch.
- Verify `main`, `Dev`, and `Master` resolve to the same local and remote commit.

### Backend tests

- Migration and Prisma schema constraints.
- Message persistence, conversation update, and outbox atomicity.
- One notification event per non-sender participant and no sender notification.
- Message idempotency and safe-preview redaction.
- Listing moderation, expiration, favorite, review, saved-search, system, security, and broadcast producers.
- Preference defaults and mandatory categories.
- Ownership, pagination, read, read-all, soft-delete, and count reconciliation.
- Worker claim, retry, dead-letter, restart, aggregation, and graceful shutdown.
- SSE authentication, headers, heartbeat, signal shape, stream cap, and cleanup.
- Proxy-aware rate limiting with distinct forwarded client buckets.

### Frontend tests

- Provider authentication lifecycle and logout reset.
- Stream parsing, visibility behavior, backoff, and polling fallback.
- Bell and mobile message badge reconciliation including `99+`.
- Popover tabs, keyboard behavior, mark-all, navigation, and rollback.
- Notification-center filters, pagination, loading, empty, offline, and error states.
- Preference toggles and locked mandatory categories.
- Message pending/sent/failed/retry and online queue flush.
- Dashboard error state instead of false zero.

### End-to-end tests

At minimum, automated or repeatable production-parity flows cover:

1. Two verified accounts: send message, observe global badge without visiting messages, observe bell item, open target conversation, and verify both counters clear.
2. Duplicate/ambiguous submission: verify one persisted message and one notification.
3. Listing approval and rejection: verify the owner receives the correct notification and navigation target.
4. Favorite aggregation: verify repeated favorites aggregate without notifying the owner for self-favorites.
5. Offline/reconnect: verify queued send and counter reconciliation.
6. Unauthorized access: verify one user cannot list, mutate, or stream another user's notifications.

## Deployment and Rollout

1. Integrate and verify Git history in an isolated worktree.
2. Deploy the additive database migration and models.
3. Deploy backend routes, worker, producers, read synchronization, metrics, and cleanup with frontend entry points disabled.
4. Confirm worker startup, zero unexpected dead rows, bounded queue age, and ownership behavior.
5. Deploy provider, badges, bell, popover, center, preferences, and messaging improvements.
6. Enable SSE after confirming Nginx buffering and timeout configuration.
7. Run production smoke tests with two controlled verified accounts.
8. Monitor API errors, 429s, outbox queue depth/age, dead rows, active streams, reconnects, and unread-count latency.
9. Only after production verification, align `Dev` and `Master`, push archive tags, delete obsolete branches, and remove obsolete worktrees.

Rollback disables event production, worker startup, SSE, and frontend entry points while leaving additive database tables intact. Existing messaging continues to function through REST and safe polling.

## Observability and Operations

Structured metrics and logs cover:

- outbox pending count and oldest pending age;
- processed, failed, retried, and dead event counts by type;
- notification creation and aggregation by type;
- unread-count endpoint latency;
- active SSE connections and close/reconnect reasons;
- message send, idempotency hit, and offline retry outcomes;
- cleanup counts and durations.

Health output exposes only aggregate state. It never includes notification content or user identifiers. An operational runbook documents replaying recoverable failed events, inspecting dead rows, disabling the worker, disabling SSE, and validating branch/tag recovery.

## Documentation Deliverables

- Update architecture and API references.
- Update deployment and operations documentation with worker/SSE/Nginx requirements.
- Update security documentation with notification privacy and ownership guarantees.
- Update project documentation and roadmap to reflect implemented status.
- Record branch consolidation decisions, excluded commits, final commit IDs, archive tags, tests, deployment result, and deleted branches in a consolidation report.
- Update `memory/known-issues.md`, `memory/decisions.md`, and `memory/worklog.md` without including secrets or generated outputs.

## Explicit Non-Goals for This Release

- Group conversations and per-participant read receipts.
- Native mobile applications.
- SMS or WhatsApp delivery.
- Marketing campaigns authored by ordinary users.
- Multi-instance real-time fan-out before a shared broker is introduced.

Browser Web Push/FCM is a follow-on delivery channel after the complete in-app system is stable. The data model and preferences may be extended for it, but push permission prompts, service workers, device-token lifecycle, and push delivery do not block this release.

