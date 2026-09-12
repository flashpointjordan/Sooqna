# Main Consolidation and Complete Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all useful work onto `main`, deliver durable real-time in-app notifications and globally visible message unread state, deploy and verify the result, mirror it to `Dev` and `Master`, and safely remove every other branch.

**Architecture:** Start from a clean worktree attached to `main` and integrate only audited commits. PostgreSQL is authoritative: business writes create idempotent outbox records, a bounded worker materializes notifications, SSE emits content-free change signals, and a global React provider reconciles state through REST. Branch cleanup happens only after archive tags, clean worktrees, green tests, and verified production.

**Tech Stack:** Git worktrees, GitHub Actions, Next.js 15, React 19, TypeScript 5.7, Express 4, Prisma 7, PostgreSQL, Firebase Auth, Jest/Supertest, Playwright, SSE, Nginx, PM2.

---

## File Map

### Imported backend foundation

- Import notification schema/migration and `backend/sooqna-backend/src/modules/notifications/*` from `codex/notification-system`.
- Import production proxy commit `4c75e6f` from `codex/rate-limit-proxy-fix`.
- Modify `backend/sooqna-backend/src/routes/index.ts`, `src/app.ts`, `src/server.ts`, and deployment configuration through those audited commits.

### Backend completion

- Create `backend/sooqna-backend/src/shared/database/unitOfWork.ts`.
- Modify Prisma `Message` for client idempotency and unread indexes before the new migration reaches production.
- Modify message, favorite, review, moderation, listing-lifecycle, and saved-search services to enqueue typed events.
- Create/extend notification producer, read-sync, broadcast, cleanup, health, and metrics tests.
- Complete notification counts, broadcast fan-out, cleanup, and operational health.

### Frontend completion

- Create `apps/web/src/types/notification.ts`.
- Create `apps/web/src/services/notificationService.ts` and `notificationStream.ts`.
- Create `apps/web/src/contexts/notification-context.tsx`.
- Create focused components under `apps/web/src/components/notifications/`.
- Create `apps/web/src/app/notifications/page.tsx`.
- Modify providers, header actions, mobile navigation, account settings/dashboard, and messaging workspace/chat.
- Create focused Node tests and `apps/web/tests/e2e/notifications.spec.ts`.

### Operations and documentation

- Create `docs/operations/notifications-runbook.md`.
- Create `docs/branch-consolidation-2026-09-11.md`.
- Update architecture, API, deployment, security, roadmap, project reference, and `memory/*.md`.

---

### Task 1: Inventory and Preserve Every Existing Change

**Files:**
- Create: `docs/branch-consolidation-2026-09-11.md`
- Preserve: current primary-worktree documentation edits
- Preserve: `backend/sooqna-backend/src/modules/notifications/notifications.producers.test.ts`

- [ ] **Step 1: Fetch and record immutable starting state**

Run from the repository root:

```powershell
git fetch --prune origin
git status --short --branch
git for-each-ref --format="%(refname:short)|%(objectname)|%(upstream:short)|%(subject)" refs/heads refs/remotes/origin
git worktree list --porcelain
git rev-list --left-right --count main...Dev
git rev-list --left-right --count main...Master
git rev-list --left-right --count main...softshop
git rev-list --left-right --count main...codex/notification-system
git rev-list --left-right --count main...codex/rate-limit-proxy-fix
```

Expected: `Dev` and `Master` have no unique commits; notification has the audited backend series; rate-limit has one useful non-equivalent proxy commit; every dirty worktree is listed.

- [ ] **Step 2: Create local archive tags before moving refs**

```powershell
git tag -a archive/2026-09-11/softshop softshop -m "Archive softshop before main consolidation"
git tag -a archive/2026-09-11/origin-softshop origin/softshop -m "Archive origin softshop before main consolidation"
git tag -a archive/2026-09-11/rate-limit-proxy-fix codex/rate-limit-proxy-fix -m "Archive rate-limit branch before main consolidation"
git tag -a archive/2026-09-11/notification-system codex/notification-system -m "Archive notification branch before main consolidation"
git tag -a archive/2026-09-11/admin-product-analytics origin/codex/admin-product-analytics-enhancements -m "Archive analytics branch before main consolidation"
```

Expected: each tag resolves to the recorded head. Do not push tags or delete branches yet.

- [ ] **Step 3: Preserve the primary worktree on a temporary branch**

Create `preserve/softshop-wip-2026-09-11`. Review and stage only:

```text
CLAUDE.md
README.md
docs/README.md
docs/project-documentation.md
docs/superpowers/plans/2026-05-28-admin-product-analytics-enhancements.md
docs/superpowers/plans/2026-07-09-conservative-project-cleanup.md
docs/superpowers/specs/2026-07-09-conservative-project-cleanup-design.md
docs/superpowers/specs/2026-09-11-main-consolidation-notification-system-design.md
docs/superpowers/plans/2026-09-11-main-consolidation-notifications.md
memory/README.md
memory/known-issues.md
memory/decisions.md
memory/worklog.md
```

Confirm the cached name-status contains no source, secrets, screenshots, dependencies, or generated files, then commit:

```powershell
git commit -m "docs: preserve project consolidation work"
```

- [ ] **Step 4: Preserve the untracked notification producer test**

In `.worktrees/main-rate-limit-integration`, confirm the producer test is the only untracked file, stage it, and commit:

```powershell
git add -- backend/sooqna-backend/src/modules/notifications/notifications.producers.test.ts
git commit -m "test: expose missing notification producers"
```

Run the focused notification suite. Expected baseline: foundation tests pass and producer integration remains red.

- [ ] **Step 5: Write the acceptance/rejection manifest**

The consolidation document must state:

```text
ACCEPT: commit 4c75e6f (trusted production proxy)
ACCEPT: notification-system commit series and preserved producer test
ACCEPT AFTER ACCURACY REVIEW: project documentation and memory edits
REJECT: deploy-softshop.yml because production deploys main
REJECT: patch-equivalent rate-limit commits already present on main
```

Commit only the manifest as `docs: record branch consolidation inventory`.

---

### Task 2: Build the Integration Directly on a Clean Main Worktree

**Files:** Imported by audited cherry-picks only.

- [ ] **Step 1: Create a worktree attached to `main`**

```powershell
git worktree add .worktrees/main-notifications main
```

Expected: clean status at current `origin/main` or its fetched fast-forward successor.

- [ ] **Step 2: Port the unique proxy fix**

```powershell
git cherry-pick 4c75e6f7895b6f7870b17b80143537ee04471e65
```

Expected: trusted-proxy implementation/tests and `TRUST_PROXY=1` enter the main deployment workflow; `deploy-softshop.yml` does not appear.

- [ ] **Step 3: Import the notification foundation in reviewed order**

```powershell
git cherry-pick be5581280c0d47e7f9e3a96c8b13c4dffc414de9^..6febfba7b2bb8ffc3f9676ff3f80e8a31a6a8a66
```

Expected: schema, migration, templates, REST, worker, SSE, tests, design, and original notification plan are present.

- [ ] **Step 4: Import preserved test and approved documentation**

Cherry-pick the producer-test commit. Restore the two 2026-09-11 documents from the preservation commit and commit them as `docs: add main consolidation plan`. Review each remaining documentation path against current `main`; restore only accurate content and record every rejection.

- [ ] **Step 5: Verify imported baseline**

From the backend:

```powershell
npm run prisma:generate
npm run typecheck
npm test -- --runInBand src/modules/notifications
```

Expected: typecheck passes; only explicitly preserved missing-producer assertions remain red.

---

### Task 3: Add Message Idempotency and Unread Indexes Before Migration Release

**Files:**
- Modify: `backend/sooqna-backend/prisma/schema.prisma`
- Modify: `backend/sooqna-backend/prisma/migrations/20260824000100_add_notifications/migration.sql`
- Modify: `backend/sooqna-backend/src/shared/validation/schemas.ts`
- Modify: message types
- Test: notification schema test

- [ ] **Step 1: Write failing schema assertions**

Require this final message model shape:

```prisma
model Message {
  id              String    @id
  conversationId  String
  senderId        String
  clientRequestId String?
  type            String
  text            String
  attachments     Json
  isRead          Boolean
  readAt          DateTime?
  createdAt       DateTime
  deletedAt       DateTime?

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@unique([conversationId, senderId, clientRequestId], map: "messages_conversation_sender_request_unique")
  @@index([conversationId, isRead, deletedAt, senderId], map: "messages_unread_lookup_idx")
}
```

- [ ] **Step 2: Run RED**

Run the schema test. Expected: missing field/constraint/index failures.

- [ ] **Step 3: Update schema, unreleased migration, validation, and types**

Message input must require:

```ts
clientRequestId: z.string().trim().min(8).max(128)
```

Identity still comes from verified authentication; never accept a client sender ID.

- [ ] **Step 4: Validate and commit**

```powershell
npx prisma format --check
npx prisma validate
npm run prisma:generate
npm run typecheck
npm test -- --runInBand src/modules/notifications/notifications.schema.test.ts
```

Expected: all pass. Commit `feat: add idempotent message schema`.

---

### Task 4: Make Message, Conversation, and Outbox Writes Atomic

**Files:**
- Create: `backend/sooqna-backend/src/shared/database/unitOfWork.ts`
- Modify: message repository/service/controller/tests
- Extend: producer test

- [ ] **Step 1: Define the failing transaction contract**

The producer test must prove one transaction, one message, one conversation update, one event per non-sender, deterministic dedupe, and no raw body/email/password/token in outbox payload.

- [ ] **Step 2: Add injectable transaction runner**

```ts
import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";

export type TransactionContext = Prisma.TransactionClient;
export type TransactionRunner = <T>(
  work: (tx: TransactionContext) => Promise<T>
) => Promise<T>;

export const runPrismaTransaction: TransactionRunner = (work) =>
  prisma.$transaction(work);
```

Repository write methods accept optional transaction context and use `tx ?? prisma`.

- [ ] **Step 3: Implement idempotent atomic creation**

Inside one transaction:

1. Return an existing message for the same conversation/sender/clientRequestId.
2. Insert the message.
3. Update conversation last-message fields.
4. Insert one `MESSAGE_RECEIVED` outbox row per non-sender participant.
5. Use `message:<messageId>:<recipientId>` as dedupe key.

Generate a redacted 120-character preview through the notification sanitizer. A transactional outbox failure rolls back the message.

- [ ] **Step 4: Return canonical creation status**

```ts
res.status(result.created ? 201 : 200).json({
  success: true,
  message: result.message,
  created: result.created,
});
```

- [ ] **Step 5: Verify and commit**

Run message identity, producer, repository, service, and typecheck suites. Expected: message producer assertions are green. Commit `feat: produce message notifications atomically`.

---

### Task 5: Wire Favorite and Review Producers

**Files:** favorites/reviews services, repositories, tests, producer tests.

- [ ] **Step 1: Correct favorite creation semantics**

Repository upsert returns the atomic mutation result `{ created, favoriteCount, sourceId?, sourceTimestamp?, sourceVersion? }`. Notify only for a newly created favorite, never removal, duplicate add, missing owner, or self-favorite. A duplicate retry while the favorite remains active is idempotent. After remove, a later add persists a new durable cycle `sourceId`, so add -> remove -> add produces two independently deliverable events without weakening retry dedupe.

Event facts:

```ts
{
  aggregateType: "listing",
  aggregateId: listing.id,
  recipientId: listing.ownerId,
  dedupeKey: "favorite:<listingId>:<actorId>:<sourceId>",
  aggregationKey: "listing-favorite:<listingId>:<UTC-hour>",
  payload: {
    eventType: "LISTING_FAVORITED_AGGREGATE",
    recipientId: listing.ownerId,
    listingId: listing.id,
    listingTitle: listing.title,
    favoriteCount,
    sourceId,
    sourceTimestamp,
    sourceVersion,
  },
}
```

The repository serializes favorite mutations per listing and captures `favoriteCount` with the durable monotonic `sourceVersion`. The worker uses that internal version to reject delayed stale aggregate events even when timestamps are equal. `sourceId`, `sourceTimestamp`, and `sourceVersion` are persisted for dedupe/freshness only and are filtered from public `NotificationDto.metadata`.

- [ ] **Step 2: Produce review events**

After review persistence and seller-stat recalculation, resolve authoritative reviewer name/listing title and enqueue `REVIEW_RECEIVED` with rating and IDs only. Exclude review comment. Dedupe key is `review:<reviewId>:<sellerId>`.

- [ ] **Step 3: Preserve successful legacy writes when post-commit enqueue fails**

Where a transaction cannot yet be shared, log only event type, aggregate ID (`listingId` or `reviewId`), recipient ID, and outcome; never content or credentials, and keep the successful business response.

- [ ] **Step 4: Verify and commit**

Run producer, favorite, review, engagement, and typecheck suites. Expected: all five previously failing producer tests pass. Commit `feat: produce engagement notifications`.

---

### Task 6: Wire Moderation, Expiration, and Saved-Search Producers

**Files:**
- Modify: `backend/sooqna-backend/src/modules/admin/admin.routes.ts`
- Modify: listing lifecycle modules/tests
- Create: `backend/sooqna-backend/src/modules/notifications/savedSearchMatcher.ts`
- Test: `notifications.listing-producers.test.ts`

- [ ] **Step 1: Write failing moderation tests**

Publish emits `LISTING_APPROVED`; reject emits `LISTING_REJECTED` with safe validated reason; archive/sold/feature actions do not emit those types. Bulk actions use deterministic per-listing keys.

- [ ] **Step 2: Make moderation and outbox atomic**

Use authoritative database owner/title and keys:

```text
listing-approved:<listingId>:<publishedAt>
listing-rejected:<listingId>:<updatedAt>
```

- [ ] **Step 3: Add lifecycle production**

Daily lifecycle logic emits expiring once per listing/UTC day in the warning window and expired once per state transition. No backfill runs inside a migration.

- [ ] **Step 4: Add bounded saved-search matching**

On publish, process saved searches in pages using canonical listing-search normalization. Enqueue hourly aggregates per saved search/user, cap listed IDs at ten, and retain total count.

- [ ] **Step 5: Verify and commit**

Run moderation, listing, saved-search, template, worker, and typecheck suites. Commit `feat: produce listing and saved-search notifications`.

---

### Task 7: Synchronize Conversation Read State and Optimize Unread Queries

**Files:** message repository/service/controller, notification repository/service, read-sync test, indexes.

- [ ] **Step 1: Write failing cross-read test**

Two unread messages plus two unread message notifications must produce:

```ts
{
  updatedMessages: 2,
  updatedNotifications: 2,
  messageUnreadTotal: 0,
  notificationUnreadTotal: 0,
}
```

Other users and conversations remain unchanged.

- [ ] **Step 2: Implement one transactional read operation**

Mark other-sender messages and the user's active, unexpired `MESSAGE_RECEIVED` notifications for the conversation read in one transaction. Publish one content-free signal after commit.

- [ ] **Step 3: Move unread aggregation into PostgreSQL**

Replace `findMany` plus JavaScript reduction with database grouping/aggregate while retaining participant ownership.

- [ ] **Step 4: Validate indexes with query plans**

Run `EXPLAIN (ANALYZE, BUFFERS)` against representative staging volume. Record use of composite indexes and absence of full table scans.

- [ ] **Step 5: Verify and commit**

Run read-sync, message, notification repository/service, and typecheck suites. Commit `fix: reconcile message and notification read state`.

---

### Task 8: Complete Counts, Broadcasts, Cleanup, and Health

**Files:** notification module plus server/health integration.

- [ ] **Step 1: Add canonical count DTO and endpoint**

```ts
export type NotificationUnreadCountsDto = {
  total: number;
  byCategory: Record<NotificationCategory, number>;
};
```

Expose `GET /api/notifications/unread-counts`. Count only owned, unread, active, unexpired rows.

- [ ] **Step 2: Implement ADMIN broadcast fan-out**

Validate audience, safe title/body, and internal action URL. Persist/resume bounded fan-out with deterministic events and audit entries that omit body content.

- [ ] **Step 3: Implement cleanup**

In bounded idempotent batches, delete expired/soft-deleted notifications, processed outbox rows older than 14 days, and dead rows older than 30 days. Schedule daily and stop cleanly.

- [ ] **Step 4: Add privacy-safe operational health**

Expose aggregate queue depth, oldest pending age, dead count, worker state, and active streams. Never expose content or user IDs.

- [ ] **Step 5: Verify and commit**

Run broadcast, cleanup, health, worker, broker, routes, and typecheck suites. Commit `feat: complete notification operations`.

---

### Task 9: Build Typed REST and SSE Frontend Clients

**Files:**
- Create notification types, REST service, stream parser, and tests.

- [ ] **Step 1: Write failing tests**

Cover cursor pages, counts, mutations, preferences, fragmented SSE frames, comments, malformed JSON, abort, content-type validation, and reconnect classification.

- [ ] **Step 2: Define stable contracts**

```ts
export type NotificationCategory =
  | "MESSAGES"
  | "LISTINGS"
  | "ENGAGEMENT"
  | "SAVED_SEARCHES"
  | "SYSTEM"
  | "SECURITY";

export type NotificationUnreadCounts = {
  total: number;
  byCategory: Record<NotificationCategory, number>;
};
```

Also define item, cursor page, preferences, and version-1 signal.

- [ ] **Step 3: Implement REST calls**

Safe reads may use bounded retry. Writes remain single-attempt unless explicitly idempotent. Preserve HTTP status, application code, and `Retry-After`.

- [ ] **Step 4: Implement authenticated streamed fetch**

Use a fresh Firebase token in Authorization header, require `text/event-stream`, parse cross-chunk frames, ignore heartbeats, and never log or place the token in the URL.

- [ ] **Step 5: Verify and commit**

Run focused Node tests, typecheck, and lint. Commit `feat: add notification web client`.

---

### Task 10: Add the Global Notification Provider

**Files:**
- Create: `apps/web/src/contexts/notification-context.tsx`
- Test: `apps/web/tests/notificationState.test.ts`
- Modify: `apps/web/src/app/providers.tsx`

- [ ] **Step 1: Test reducer and lifecycle**

Cover initial fetch, server replacement of counts, optimistic rollback, mark-all, logout/user-switch reset, visibility, reconnect backoff, and 60-second fallback polling only when SSE is unavailable.

- [ ] **Step 2: Implement provider state**

Own notification counts, message unread summary, latest items, connection state, error, current user, and a message-refresh revision.

- [ ] **Step 3: Implement lifecycle**

On user change, abort old stream and clear private state. Fetch both count sources, connect only while visible, reconcile after every signal/reconnect/mutation, and refetch message unread state for message-category signals.

- [ ] **Step 4: Mount in correct order**

```tsx
<AuthProvider>
  <ThemeProvider>
    <NotificationProvider>{children}</NotificationProvider>
  </ThemeProvider>
</AuthProvider>
```

- [ ] **Step 5: Verify and commit**

Run state tests, typecheck, and lint. Commit `feat: add global notification lifecycle`.

---

### Task 11: Add Mobile Message Badge, Bell, and Popover

**Files:** notification presentation components, `BottomNav.tsx`, `PublicNavActions.tsx`, `PublicShell.tsx`, presentation test.

- [ ] **Step 1: Test mappings and badge cap**

Zero hides, 1–99 display numerically, 100 displays `99+`; every known type and safe unknown fallback render.

- [ ] **Step 2: Add bottom message badge**

Badge uses message unread total. Accessible label becomes `الرسائل، <count> غير مقروءة`. Signed-out users show no badge/request.

- [ ] **Step 3: Add bell in desktop and mobile header**

Bell uses total notification unread count and remains reachable from both responsive layouts.

- [ ] **Step 4: Build rich popover**

All/Unread tabs, latest eight, category icon, safe body, relative time, unread marker, mark-all, settings/center links, skeleton/error/empty states, RTL placement, Escape, outside-click, focus return, and polite live announcements.

- [ ] **Step 5: Verify and commit**

Run presentation tests, typecheck, lint, and 375px/1280px responsive checks. Commit `feat: surface global notification badges`.

---

### Task 12: Build Full Center and Preferences

**Files:** `/notifications` page, center components, preference component, account settings, tests.

- [ ] **Step 1: Test state helpers**

Cover Today/Yesterday/Earlier groups, category/unread filters, deduplicated cursor append, optimistic rollback, locked mandatory categories, and preference rollback.

- [ ] **Step 2: Build center**

Desktop category sidebar, mobile chips, All/Unread, 20-item pages, load more, read/delete/mark-all, skeleton, empty, reconnect/offline, recoverable error, and retry.

- [ ] **Step 3: Build preferences**

Messages, Listings, Engagement, and Saved Searches are optional. System/Security are checked and locked with `إشعارات النظام والأمان إلزامية`. Failed reads show a warning rather than false saved defaults.

- [ ] **Step 4: Verify and commit**

Run center tests, typecheck, lint, and production build with documented environment. Commit `feat: add notification center and preferences`.

---

### Task 13: Complete Message Delivery and Offline Recovery

**Files:** message types/service/workspace/chat, dashboard, delivery-state test.

- [ ] **Step 1: Test message state machine**

Cover pending-to-sent, pending-to-failed, retry with unchanged clientRequestId, online flush, duplicate replay, and provider-triggered single-flight refresh.

- [ ] **Step 2: Send a stable request ID**

Generate before optimistic insertion; store in offline queue; reuse on every retry. Keep failed text visible with retry rather than deleting it.

- [ ] **Step 3: Flush on browser online event**

Register one authenticated lifecycle listener, flush sequentially, retain failures, reconcile afterward, and remove listener on logout/unmount.

- [ ] **Step 4: Correct dashboard errors and Arabic copy**

Unread-fetch failure renders unavailable/retry, never zero. Standardize `الرسائل`, `لا توجد رسائل بعد`, and `رسالة جديدة من …`.

- [ ] **Step 5: Verify and commit**

Run delivery, polling, retry, typecheck, and lint. Commit `feat: complete message delivery experience`.

---

### Task 14: Add End-to-End and Recovery Journeys

**Files:** `apps/web/tests/e2e/notifications.spec.ts`, stable selectors, Playwright config only if needed.

- [ ] **Step 1: Add stable selectors**

Use `notification-bell`, `notification-count`, `message-unread-count`, `notification-popover`, `notification-item-<id>`, and `message-send-state-<id>`.

- [ ] **Step 2: Two-account journey**

Send as buyer; remain outside messages as seller; assert badge/bell; open notification; assert target conversation; verify both counters clear after reload and relogin.

- [ ] **Step 3: Duplicate and reconnect journeys**

Replay one clientRequestId and assert one message/notification. Disconnect SSE, send, reconnect/restore visibility, and assert REST recovery without duplication.

- [ ] **Step 4: Moderation and ownership journeys**

Approve/reject controlled listings and assert safe owner items. Assert another user cannot list/read/delete/stream them.

- [ ] **Step 5: Verify and commit**

Run notification Playwright spec in Chromium. Commit `test: cover notification user journeys`.

---

### Task 15: Run Complete Pre-Deployment Verification

**Files:** only scoped regression fixes discovered by checks.

- [ ] **Step 1: Backend matrix**

```powershell
npx prisma format --check
npx prisma validate
npm run prisma:generate
npm run typecheck
npm test -- --runInBand
npm run build
```

Expected: all exit 0; no skipped/failing producer test.

- [ ] **Step 2: Web matrix**

```powershell
npx tsx tests/requestRetry.test.ts
npx tsx tests/messagePolling.test.ts
npx tsx tests/notificationService.test.ts
npx tsx tests/notificationStream.test.ts
npx tsx tests/notificationState.test.ts
npx tsx tests/notificationPresentation.test.ts
npx tsx tests/notificationCenterState.test.ts
npx tsx tests/messageDeliveryState.test.ts
npm run lint
npx tsc --noEmit
npm run build
npx playwright test tests/e2e/notifications.spec.ts --project=chromium
```

Expected: all exit 0. Do not build while Next dev is running.

- [ ] **Step 3: Git, migration, and privacy review**

Require clean status, `git diff --check`, additive migration, absence of softshop deployment workflow, internal action URLs, owner-scoped mutations, and no bodies/tokens/emails/passwords in signals or logs.

- [ ] **Step 4: Fix only verified defects**

Every correction starts with a failing regression test and ends in a focused commit. Record exact commands/results and final commit in the consolidation document.

---

### Task 16: Document Operations and Rollout

**Files:** runbook, architecture/API/deployment/security/roadmap/project docs, memory.

- [ ] **Step 1: Write operations runbook**

Include queue/dead-row inspection, worker/SSE disable switches, privacy-safe PM2 diagnostics, eligible retry procedure, cleanup, and additive-schema rollback.

- [ ] **Step 2: Update maintained references**

Document routes, transaction/outbox boundary, SSE auth/header/proxy settings, retention, preferences, message idempotency, and single-process broker constraint.

- [ ] **Step 3: Update memory**

Record decisions, one-to-one read-model limit, multi-instance broker prerequisite, and worklog without secrets/log dumps.

- [ ] **Step 4: Verify and commit**

Search maintained docs for placeholder markers and stale softshop deployment claims. Commit `docs: document notification operations and consolidation`.

---

### Task 17: Deploy Main and Verify Production

**Files:** no edits unless a production defect first receives a regression test.

- [ ] **Step 1: Push archive tags, then main**

Push all five archive tags. Push `main`. Expected: CI runs on the exact local commit and production deploy begins only after CI success.

- [ ] **Step 2: Verify migration/backend**

Confirm migration, DB preflight, PM2 restart, worker health, bounded queue age, zero unexpected dead events, owner-scoped REST, and stream headers including `X-Accel-Buffering: no`.

- [ ] **Step 3: Run controlled two-account production smoke**

Send A to B; B sees badge/bell without entering messages; click target; counts clear; reload and relogin preserve canonical state.

- [ ] **Step 4: Exercise other types**

Controlled approval/rejection, non-self favorite, review, saved-search match, and admin announcement must each create correct, deduplicated, internally navigable notifications.

- [ ] **Step 5: Stabilization gate**

Monitor worker retries, dead rows, SSE reconnects, 429 rates, unread latency, and PM2 restarts. Do not clean branches until all are healthy.

---

### Task 18: Mirror Dev/Master and Remove All Other Branches

**Files:**
- Finalize: `docs/branch-consolidation-2026-09-11.md`

- [ ] **Step 1: Re-fetch and detect late branch movement**

```powershell
git fetch --prune origin
git show-ref --verify refs/remotes/origin/main
git show-ref --verify refs/remotes/origin/Dev
git show-ref --verify refs/remotes/origin/Master
```

If a deletion target moved, archive its new head and repeat unique-patch audit.

- [ ] **Step 2: Align local mirrors**

```powershell
$finalMainCommit = git rev-parse main
git branch -f Dev $finalMainCommit
git branch -f Master $finalMainCommit
```

Expected: all three local hashes match.

- [ ] **Step 3: Align remote mirrors with leases**

```powershell
$oldRemoteDev = git rev-parse origin/Dev
$oldRemoteMaster = git rev-parse origin/Master
git push origin main
git push --force-with-lease=Dev:$oldRemoteDev origin main:Dev
git push --force-with-lease=Master:$oldRemoteMaster origin main:Master
```

A lease failure stops cleanup; never use unconditional force.

- [ ] **Step 4: Remove obsolete worktrees safely**

Confirm clean status in the rate-limit and notification worktrees. Remove them only through `git worktree remove <exact-path>`; never recursively delete them.

- [ ] **Step 5: Delete obsolete remote branches**

```powershell
git push origin --delete softshop
git push origin --delete codex/admin-product-analytics-enhancements
```

If remote notification/rate-limit branches exist at execution time, archive their fetched heads and delete them explicitly. Expected remaining remote branches: `main`, `Dev`, `Master`, and `origin/HEAD`.

- [ ] **Step 6: Delete obsolete local branches**

```powershell
git branch -d softshop
git branch -d codex/notification-system
git branch -d codex/rate-limit-proxy-fix
git branch -d preserve/softshop-wip-2026-09-11
```

If `-d` refuses, audit `git cherry -v main <branch>` and tree diff. Use `-D` only after the report proves every change was accepted, rejected, or protected by a pushed archive tag.

- [ ] **Step 7: Final ref audit**

```powershell
git fetch --prune origin
git for-each-ref --format="%(refname:short)|%(objectname)" refs/heads refs/remotes/origin
git worktree list --porcelain
git status --short --branch
```

Expected: only local/remote `main`, `Dev`, `Master` (plus `origin/HEAD`); all six refs point to the same final commit; no obsolete worktree.

- [ ] **Step 8: Finalize report and mirror final documentation commit**

Record final commit, CI/deploy evidence, production checks, aligned refs, deleted branches, archive tags, and earliest tag-removal date. Commit `docs: finalize branch consolidation`, push `main`, and repeat the leased mirror update so `Dev` and `Master` include the final report.

---

## Final Acceptance Checklist

- [ ] Messages persist exactly once and notify every non-sender exactly once.
- [ ] Message badge appears globally without opening `/messages`.
- [ ] Bell, popover, center, dashboard, and conversation reads reconcile after mutation/reconnect.
- [ ] All ten event types have templates, producers, preferences, and tests.
- [ ] Broadcasts, cleanup, worker retries/dead-letter, and SSE are operational.
- [ ] No private content or credentials appear in signals or logs.
- [ ] Backend, web, migration, E2E, security, and production checks pass.
- [ ] Production deploys only from `main`.
- [ ] `main`, `Dev`, and `Master` are identical locally and remotely.
- [ ] Every deleted branch is recoverable through a pushed archive tag during retention.
- [ ] All other branches and obsolete worktrees are removed.
