# In-app Notification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, real-time, in-app notification system for Sooqna with a rich header popover, full notification center, category preferences, marketplace event producers, and administrative broadcasts.

**Architecture:** PostgreSQL/Prisma is the source of truth. Marketplace mutations enqueue idempotent outbox events, a bounded worker turns them into user notifications, and an in-memory SSE broker emits content-free change signals; authenticated REST always performs reads and recovery. The Next.js client owns one visible-tab stream per session and renders the shared notification state in the bell, popover, center, and settings.

**Tech Stack:** TypeScript 5.7, Express 4, Prisma 7/PostgreSQL, Jest/Supertest, Next.js 15, React 19, Firebase Auth, Tailwind CSS, Playwright.

---

## File map

### Backend data and core

- Modify `backend/sooqna-backend/prisma/schema.prisma`: add notification enums, relations, and four durable models.
- Create `backend/sooqna-backend/prisma/migrations/20260824000100_add_notifications/migration.sql`: additive SQL migration and indexes.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.types.ts`: public DTOs, event payloads, cursor helpers, and preference types.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.templates.ts`: centralized Arabic copy and safe action URL generation.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.repository.ts`: all user-scoped persistence and atomic outbox claims.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.service.ts`: preference, ownership, dedupe, aggregation, and list/mutation rules.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.controller.ts`: HTTP response mapping.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.routes.ts`: authenticated REST and SSE routes.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.schemas.ts`: Zod validation for query, params, preferences, and broadcasts.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.broker.ts`: single-process per-user SSE registry and connection cap.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.worker.ts`: outbox retry/dead-letter and broadcast fan-out loop.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.producer.ts`: small idempotent domain-event enqueue API.
- Create `backend/sooqna-backend/src/modules/notifications/notifications.cleanup.ts`: bounded retention cleanup.
- Create `backend/sooqna-backend/scripts/cleanup-notifications.ts`: manually/cron-invoked cleanup entry point.
- Modify `backend/sooqna-backend/src/routes/index.ts`: mount `/notifications`.
- Modify `backend/sooqna-backend/src/app.ts`: add stream-attempt and notification-write limiters.
- Modify `backend/sooqna-backend/src/server.ts`: start and gracefully stop the worker.
- Modify `backend/sooqna-backend/package.json`: add worker/cleanup scripts.

### Backend event integration

- Modify `backend/sooqna-backend/src/modules/messages/messages.service.ts`: enqueue `MESSAGE_RECEIVED` after message persistence.
- Modify `backend/sooqna-backend/src/modules/favorites/favorites.service.ts`: enqueue favorite aggregates only on a newly created favorite and never for self-favorites.
- Modify `backend/sooqna-backend/src/modules/favorites/repositories/favorites.repository.ts`: return whether upsert inserted a row.
- Modify `backend/sooqna-backend/src/modules/reviews/reviews.service.ts`: enqueue `REVIEW_RECEIVED` after review creation.
- Modify `backend/sooqna-backend/src/modules/admin/admin.routes.ts`: transactional moderation events and broadcast endpoints.
- Modify `backend/sooqna-backend/src/modules/listings/listings.service.ts`: enqueue saved-search matching after publication/renewal.
- Create `backend/sooqna-backend/src/modules/notifications/saved-search-matcher.ts`: reuse listing filter normalization to find matching saved searches.
- Create `backend/sooqna-backend/src/modules/notifications/listing-expiration.job.ts`: deterministic expiring/expired events and state updates.

### Web application

- Create `apps/web/src/types/notification.ts`: shared client DTOs.
- Modify `apps/web/src/services/apiClient.ts`: export the single API-base resolver for REST and streaming fetch.
- Create `apps/web/src/services/notificationService.ts`: REST operations and authenticated streaming fetch parser.
- Create `apps/web/src/components/notifications/notificationStream.ts`: pure retry/visibility and SSE parsing utilities.
- Create `apps/web/src/contexts/notification-context.tsx`: provider and optimistic state transitions.
- Modify `apps/web/src/app/providers.tsx`: mount `NotificationProvider` inside auth.
- Create `apps/web/src/components/notifications/NotificationBell.tsx`: accessible bell and capped badge.
- Create `apps/web/src/components/notifications/NotificationPopover.tsx`: rich All/Unread popover.
- Create `apps/web/src/components/notifications/NotificationItem.tsx`: shared safe rendering and actions.
- Modify `apps/web/src/components/layout/PublicNavActions.tsx`: place the bell for signed-in desktop users.
- Modify `apps/web/src/components/layout/PublicShell.tsx`: place the bell in the mobile header without colliding with theme/logo controls.
- Create `apps/web/src/app/notifications/page.tsx`: protected full-center route.
- Create `apps/web/src/components/notifications/NotificationCenter.tsx`: filters, grouping, pagination, errors, and empty states.
- Create `apps/web/src/components/notifications/NotificationPreferences.tsx`: optional and mandatory category controls.
- Modify `apps/web/src/components/me/AccountSettingsForm.tsx`: render notification preferences.
- Modify `apps/web/src/components/layout/BottomNav.tsx`: expose notification center on mobile for authenticated users.

### Tests

- Create focused Jest tests beside each backend notification unit.
- Create pure Node assertion tests under `apps/web/tests/` for stream, state, and presentation behavior.
- Create `apps/web/tests/e2e/notifications.spec.ts` for message and moderation flows.

---

### Task 1: Add the notification database schema

**Files:**
- Modify: `backend/sooqna-backend/prisma/schema.prisma`
- Create: `backend/sooqna-backend/prisma/migrations/20260824000100_add_notifications/migration.sql`

- [ ] **Step 1: Add a schema contract test that inspects Prisma metadata**

Create `backend/sooqna-backend/src/modules/notifications/notifications.schema.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

test.each(["Notification", "NotificationPreference", "NotificationOutbox", "NotificationBroadcast"])(
  "defines %s",
  (model) => expect(schema).toContain(`model ${model} {`)
);

test("defines stable notification enums and ownership indexes", () => {
  expect(schema).toContain("enum NotificationCategory");
  expect(schema).toContain("MESSAGE_RECEIVED");
  expect(schema).toContain("@@index([userId, deletedAt, createdAt])");
  expect(schema).toContain("@@unique([userId, category])");
  expect(schema).toContain("dedupeKey     String?  @unique");
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run from `backend/sooqna-backend`: `npm test -- --runInBand src/modules/notifications/notifications.schema.test.ts`

Expected: FAIL because the four models and enums do not exist.

- [ ] **Step 3: Add enums, relations, and models**

Add the exact enum values from the approved design and these model contracts to `schema.prisma`:

```prisma
enum NotificationCategory { MESSAGES LISTINGS ENGAGEMENT SAVED_SEARCHES SYSTEM SECURITY }
enum NotificationType { MESSAGE_RECEIVED LISTING_APPROVED LISTING_REJECTED LISTING_EXPIRING LISTING_EXPIRED LISTING_FAVORITED_AGGREGATE REVIEW_RECEIVED SAVED_SEARCH_MATCHES SYSTEM_ANNOUNCEMENT SECURITY_ALERT }
enum NotificationOutboxState { PENDING PROCESSING PROCESSED FAILED DEAD }
enum NotificationBroadcastStatus { PENDING PROCESSING COMPLETED FAILED }
enum NotificationBroadcastAudience { ALL ROLES USERS }

model Notification {
  id String @id @default(cuid())
  userId String
  type NotificationType
  category NotificationCategory
  title String
  body String
  actionUrl String?
  entityType String?
  entityId String?
  metadata Json @default("{}")
  dedupeKey String? @unique
  aggregationKey String?
  readAt DateTime?
  deletedAt DateTime?
  expiresAt DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user User @relation(fields: [userId], references: [firebaseUid], onDelete: Cascade)
  @@index([userId, deletedAt, createdAt])
  @@index([userId, readAt, deletedAt])
  @@index([aggregationKey, createdAt])
}

model NotificationPreference {
  id String @id @default(cuid())
  userId String
  category NotificationCategory
  enabled Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user User @relation(fields: [userId], references: [firebaseUid], onDelete: Cascade)
  @@unique([userId, category])
}

model NotificationOutbox {
  id String @id @default(cuid())
  eventType NotificationType
  aggregateType String
  aggregateId String
  recipientId String?
  payload Json
  dedupeKey String @unique
  state NotificationOutboxState @default(PENDING)
  attempts Int @default(0)
  availableAt DateTime @default(now())
  processedAt DateTime?
  lastError String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([state, availableAt, createdAt])
}

model NotificationBroadcast {
  id String @id @default(cuid())
  audience NotificationBroadcastAudience
  audienceValue Json
  title String
  body String
  actionUrl String?
  status NotificationBroadcastStatus @default(PENDING)
  cursor String?
  deliveredCount Int @default(0)
  createdBy String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([status, createdAt])
}
```

Add `notifications Notification[]` and `notificationPreferences NotificationPreference[]` to `User`. Generate the migration SQL with `npx prisma migrate dev --create-only --name add_notifications`, rename its timestamped directory to the fixed plan path if needed, and inspect that it contains only additive DDL.

- [ ] **Step 4: Validate schema and tests**

Run: `npx prisma validate`

Expected: `The schema at prisma/schema.prisma is valid`.

Run: `npm test -- --runInBand src/modules/notifications/notifications.schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the schema**

```bash
git add backend/sooqna-backend/prisma backend/sooqna-backend/src/modules/notifications/notifications.schema.test.ts
git commit -m "feat: add notification persistence schema"
```

### Task 2: Define notification contracts, validation, templates, and safe URLs

**Files:**
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.types.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.schemas.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.templates.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.templates.test.ts`

- [ ] **Step 1: Write failing tests for every type and URL safety**

```ts
import { NotificationType } from "@prisma/client";
import { renderNotification } from "./notifications.templates";

test.each(Object.values(NotificationType))("renders safe Arabic copy for %s", (type) => {
  const rendered = renderNotification(type, {
    senderName: "أحمد", listingTitle: "هاتف", conversationId: "conv_1",
    listingId: "lst_1", searchId: "search_1", count: 2, rating: 5, reason: "صورة غير واضحة",
  });
  expect(rendered.title.length).toBeGreaterThan(0);
  expect(rendered.body.length).toBeLessThanOrEqual(240);
  expect(rendered.actionUrl === null || rendered.actionUrl.startsWith("/")).toBe(true);
});

test("rejects external and script action URLs", () => {
  expect(() => renderNotification(NotificationType.SYSTEM_ANNOUNCEMENT, {
    title: "تنبيه", body: "نص", actionUrl: "https://evil.example",
  })).toThrow("Internal action URL required");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/notifications.templates.test.ts`

Expected: FAIL because `renderNotification` is missing.

- [ ] **Step 3: Implement typed contracts and templates**

Define `NotificationEventPayload` as a discriminated union keyed by `eventType`, `NotificationListQuery`, opaque cursor encode/decode using base64url JSON `{ createdAt, id }`, `NotificationDto`, and `NotificationPreferencesDto`. In `notifications.templates.ts`, export:

```ts
export type RenderedNotification = {
  category: NotificationCategory;
  title: string;
  body: string;
  actionUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Prisma.InputJsonValue;
};

export function assertInternalActionUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new AppError(400, "Internal action URL required", "VALIDATION_ERROR");
  }
  return value;
}

export function renderNotification(
  type: NotificationType,
  payload: Record<string, unknown>
): RenderedNotification {
  const text = (key: string) => String(payload[key] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const count = Math.max(1, Number(payload.count) || 1);
  switch (type) {
    case NotificationType.MESSAGE_RECEIVED:
      return { category: NotificationCategory.MESSAGES, title: `رسالة جديدة من ${text("senderName")}`, body: text("preview").slice(0, 120), actionUrl: assertInternalActionUrl(`/messages?conversation=${encodeURIComponent(text("conversationId"))}`), entityType: "conversation", entityId: text("conversationId"), metadata: { listingTitle: text("listingTitle") } };
    case NotificationType.LISTING_APPROVED:
      return { category: NotificationCategory.LISTINGS, title: "تم قبول إعلانك", body: `أصبح إعلان «${text("listingTitle")}» منشوراً.`, actionUrl: assertInternalActionUrl(`/listings/${encodeURIComponent(text("listingId"))}`), entityType: "listing", entityId: text("listingId"), metadata: {} };
    case NotificationType.LISTING_REJECTED:
      return { category: NotificationCategory.LISTINGS, title: "يحتاج إعلانك إلى تعديل", body: text("reason").slice(0, 240), actionUrl: assertInternalActionUrl(`/my-listings/${encodeURIComponent(text("listingId"))}`), entityType: "listing", entityId: text("listingId"), metadata: {} };
    case NotificationType.LISTING_EXPIRING:
      return { category: NotificationCategory.LISTINGS, title: "إعلانك سينتهي قريباً", body: `جدّد إعلان «${text("listingTitle")}» ليبقى ظاهراً.`, actionUrl: assertInternalActionUrl(`/my-listings/${encodeURIComponent(text("listingId"))}`), entityType: "listing", entityId: text("listingId"), metadata: {} };
    case NotificationType.LISTING_EXPIRED:
      return { category: NotificationCategory.LISTINGS, title: "انتهت مدة إعلانك", body: `تمت أرشفة إعلان «${text("listingTitle")}».`, actionUrl: assertInternalActionUrl(`/my-listings/${encodeURIComponent(text("listingId"))}`), entityType: "listing", entityId: text("listingId"), metadata: {} };
    case NotificationType.LISTING_FAVORITED_AGGREGATE:
      return { category: NotificationCategory.ENGAGEMENT, title: "إعجاب جديد بإعلانك", body: `أضاف ${count} من المستخدمين إعلان «${text("listingTitle")}» إلى المفضلة.`, actionUrl: assertInternalActionUrl(`/listings/${encodeURIComponent(text("listingId"))}`), entityType: "listing", entityId: text("listingId"), metadata: { count } };
    case NotificationType.REVIEW_RECEIVED:
      return { category: NotificationCategory.ENGAGEMENT, title: "تقييم جديد", body: `حصلت على تقييم ${Number(payload.rating) || 0} من 5.`, actionUrl: "/me", entityType: "review", entityId: text("reviewId"), metadata: { rating: Number(payload.rating) || 0 } };
    case NotificationType.SAVED_SEARCH_MATCHES:
      return { category: NotificationCategory.SAVED_SEARCHES, title: "نتائج جديدة لبحثك المحفوظ", body: `وجدنا ${count} من الإعلانات الجديدة المطابقة.`, actionUrl: assertInternalActionUrl(`/listings?search=${encodeURIComponent(text("searchId"))}`), entityType: "savedSearch", entityId: text("searchId"), metadata: { count } };
    case NotificationType.SYSTEM_ANNOUNCEMENT:
      return { category: NotificationCategory.SYSTEM, title: text("title").slice(0, 100), body: text("body").slice(0, 240), actionUrl: assertInternalActionUrl(text("actionUrl") || null), entityType: null, entityId: null, metadata: {} };
    case NotificationType.SECURITY_ALERT:
      return { category: NotificationCategory.SECURITY, title: text("title").slice(0, 100) || "تنبيه أمان", body: text("body").slice(0, 240), actionUrl: "/me/settings", entityType: "user", entityId: text("userId"), metadata: {} };
  }
}
```

The exhaustive cases use only these routes: `/messages?conversation=`, `/my-listings/`, `/listings/`, `/me`, `/listings?`, and `/notifications`. Sanitize message previews by replacing control characters, collapsing whitespace, and slicing to 120 Unicode code points; cap all bodies at 240 code points.

Create Zod schemas that constrain list `limit` to 1–50, category to the Prisma enum, `unread` to `true|false`, IDs to 1–128 characters, optional preference writes to MESSAGES/LISTINGS/ENGAGEMENT/SAVED_SEARCHES only, and broadcasts to title 1–100/body 1–240 with a safe relative action URL.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- --runInBand src/modules/notifications/notifications.templates.test.ts`

Expected: PASS for all ten enum values and unsafe URLs.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit contracts**

```bash
git add backend/sooqna-backend/src/modules/notifications
git commit -m "feat: define notification contracts and templates"
```

### Task 3: Implement user-scoped repository, service, and REST API

**Files:**
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.repository.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.service.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.controller.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.routes.ts`
- Modify: `backend/sooqna-backend/src/routes/index.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.service.test.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.routes.test.ts`

- [ ] **Step 1: Write failing service tests for ownership, preferences, cursor, and idempotency**

Use a typed fake repository and assert these exact behaviors: active rows require `userId`, `deletedAt: null`, and `expiresAt > now`; a user cannot read/delete another user's row; repeated read/delete succeeds; missing optional preference is enabled; SYSTEM/SECURITY are always enabled; duplicate `dedupeKey` returns the existing row; list returns an opaque next cursor.

```ts
test("scopes mutations to the authenticated owner", async () => {
  const repo = {
    markReadOwned: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<NotificationRepository>;
  const service = new NotificationService(repo, jest.fn());
  await expect(service.markRead("user-a", "notification-1"))
    .rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(repo.markReadOwned).toHaveBeenCalledWith("user-a", "notification-1", expect.any(Date));
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/notifications.service.test.ts src/modules/notifications/notifications.routes.test.ts`

Expected: FAIL because repository/service/router do not exist.

- [ ] **Step 3: Implement the repository interface and Prisma adapter**

Expose focused methods: `listActive`, `countUnread`, `findActiveOwned`, `markReadOwned`, `markAllRead`, `softDeleteOwned`, `getPreferences`, `upsertPreferences`, `findByDedupeKey`, `findCurrentAggregate`, `create`, and `updateAggregate`. Every owned query includes `{ userId, deletedAt: null, expiresAt: { gt: now } }`. Pagination orders by `createdAt desc, id desc` and applies the decoded tuple cursor with an OR boundary.

- [ ] **Step 4: Implement the service and HTTP layer**

The service constructor receives repository plus `publishSignal(userId, notificationId, unreadCount)`. Every new notification sets `expiresAt` to exactly 90 days after creation. It returns serialized ISO timestamps, publishes only after persistence, and reconciles `unreadCount` after every write. The router must be:

```ts
notificationsRouter.use(verifyFirebaseToken, requireCurrentUser, requireActiveUser, requireVerifiedEmail);
notificationsRouter.get("/", validateRequest({ query: notificationListQuerySchema }), asyncHandler(listNotifications));
notificationsRouter.get("/unread-count", asyncHandler(getUnreadCount));
notificationsRouter.patch("/:notificationId/read", validateRequest({ params: notificationIdParamsSchema }), asyncHandler(markNotificationRead));
notificationsRouter.post("/read-all", asyncHandler(markAllNotificationsRead));
notificationsRouter.delete("/:notificationId", validateRequest({ params: notificationIdParamsSchema }), asyncHandler(deleteNotification));
notificationsRouter.get("/preferences", asyncHandler(getNotificationPreferences));
notificationsRouter.put("/preferences", validateRequest({ body: notificationPreferencesSchema }), asyncHandler(updateNotificationPreferences));
```

Mount with `apiRouter.use("/notifications", notificationsRouter)`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --runInBand src/modules/notifications/notifications.service.test.ts src/modules/notifications/notifications.routes.test.ts`

Expected: PASS, including a Supertest 404 for cross-user mutation and max page size rejection.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit REST support**

```bash
git add backend/sooqna-backend/src/modules/notifications backend/sooqna-backend/src/routes/index.ts
git commit -m "feat: add notification REST API"
```

### Task 4: Add the durable producer and outbox worker

**Files:**
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.producer.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.worker.ts`
- Modify: `backend/sooqna-backend/src/modules/notifications/notifications.repository.ts`
- Modify: `backend/sooqna-backend/src/server.ts`
- Modify: `backend/sooqna-backend/package.json`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.worker.test.ts`

- [ ] **Step 1: Write failing retry, dedupe, aggregation, and restart tests**

Use fake timers and a fake repository. Assert PENDING/FAILED rows are claimed, favorite and saved-search hourly keys update one aggregate, success becomes PROCESSED, attempts use exponential delay plus injected jitter, attempt eight becomes DEAD, and `stop()` waits for the active batch without claiming another.

```ts
test("dead-letters the eighth failure", async () => {
  const row = { id: "outbox-1", attempts: 7 } as NotificationOutbox;
  const repo = {
    claimReady: jest.fn().mockResolvedValue([row]),
    recoverStale: jest.fn().mockResolvedValue(0),
    markProcessed: jest.fn().mockResolvedValue(undefined),
    markFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<NotificationWorkerRepository>;
  const worker = createNotificationWorker({
    repo,
    processEvent: jest.fn().mockRejectedValue(new Error("db unavailable")),
    jitter: () => 0,
    batchSize: 20,
    intervalMs: 1_000,
  });
  await worker.runOnce();
  expect(repo.markFailure).toHaveBeenCalledWith("outbox-1", {
    state: "DEAD",
    attempts: 8,
    availableAt: expect.any(Date),
    lastError: "db unavailable",
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/notifications.worker.test.ts`

Expected: FAIL because worker APIs are missing.

- [ ] **Step 3: Implement enqueue and atomic claims**

Export `enqueueNotificationEvent(input, tx = prisma)` which uses `upsert` on the unique `dedupeKey` and never stores rendered copy. Define `NotificationWorkerRepository` with `claimReady`, `recoverStale`, `markProcessed`, and `markFailure`; define `WorkerDeps` with that repository, injected `processEvent`, `jitter`, `batchSize`, and `intervalMs`. Implement claim in one transaction using `prisma.$queryRaw` with `FOR UPDATE SKIP LOCKED`, updating selected IDs to PROCESSING before commit. Recover PROCESSING rows older than five minutes to FAILED at worker startup.

- [ ] **Step 4: Implement one bounded worker loop**

```ts
export function createNotificationWorker(deps: WorkerDeps) {
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<void> | null = null;
  let stopping = false;
  const runOnce = async () => {
    const rows = await deps.repo.claimReady(deps.batchSize);
    for (const row of rows) await processClaimedRow(row, deps);
  };
  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => { if (!active && !stopping) active = runOnce().finally(() => { active = null; }); }, deps.intervalMs);
      timer.unref();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    },
  };
}
```

Use `Math.min(30_000, 1_000 * 2 ** (attempts - 1)) + jitter()` for retry delay and cap the stored `lastError` at 500 characters.

- [ ] **Step 5: Wire lifecycle and verify**

Create one worker in `server.ts`, call `start()` after `listen`, and handle SIGTERM/SIGINT by closing the HTTP server, awaiting `worker.stop()`, disconnecting Prisma, and exiting. Add `notifications:worker-once` script using `tsx` only for operational diagnosis.

Run: `npm test -- --runInBand src/modules/notifications/notifications.worker.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit worker**

```bash
git add backend/sooqna-backend/src backend/sooqna-backend/package.json
git commit -m "feat: process notification outbox reliably"
```

### Task 5: Implement authenticated SSE signals and connection controls

**Files:**
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.broker.ts`
- Modify: `backend/sooqna-backend/src/modules/notifications/notifications.routes.ts`
- Modify: `backend/sooqna-backend/src/modules/notifications/notifications.controller.ts`
- Modify: `backend/sooqna-backend/src/modules/notifications/notifications.service.ts`
- Modify: `backend/sooqna-backend/src/app.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.broker.test.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.stream.test.ts`

- [ ] **Step 1: Write failing broker and Supertest stream tests**

Assert Bearer auth is required, headers include `text/event-stream`, `no-cache`, `keep-alive`, and `X-Accel-Buffering: no`, a signal contains only event/id/count/version, heartbeat is `: heartbeat\n\n`, close removes the listener, and the fourth stream for one user is rejected with 429.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/notifications.broker.test.ts src/modules/notifications/notifications.stream.test.ts`

Expected: FAIL because the broker and stream route are absent.

- [ ] **Step 3: Implement the broker**

Use `Map<string, Set<Response>>`, a `MAX_STREAMS_PER_USER = 3`, and these public methods:

```ts
subscribe(userId: string, response: Response): () => void
publish(userId: string, signal: NotificationSignal): void
activeCount(userId?: string): number
```

`subscribe` throws a 429 AppError when capped and returns an idempotent cleanup closure. `publish` writes `event: notification.changed\ndata: ${JSON.stringify(signal)}\n\n`; it removes responses whose write throws.

- [ ] **Step 4: Implement stream response and rate limiting**

Add `GET /stream` before `GET /:notificationId` patterns. Set headers, `flushHeaders()`, write `retry: 5000\n\n`, subscribe, and send heartbeat every 25 seconds. Attach the same cleanup to `req.on("aborted")`, `req.on("close")`, and `res.on("close")`.

In `app.ts`, add a stream-attempt limiter of 30 attempts/5 minutes before the general notifications limiter and a notification-write limiter of 60 writes/5 minutes that skips GET/HEAD/OPTIONS. Do not put tokens in query strings or logs.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- --runInBand src/modules/notifications/notifications.broker.test.ts src/modules/notifications/notifications.stream.test.ts`

Expected: PASS with listener count returning to zero after close.

```bash
git add backend/sooqna-backend/src
git commit -m "feat: stream notification change signals"
```

### Task 6: Produce message, favorite, and review notifications

**Files:**
- Modify: `backend/sooqna-backend/src/modules/messages/messages.service.ts`
- Modify: `backend/sooqna-backend/src/modules/messages/messages.controller.ts`
- Modify: `backend/sooqna-backend/src/modules/favorites/favorites.service.ts`
- Modify: `backend/sooqna-backend/src/modules/favorites/repositories/favorites.repository.ts`
- Modify: `backend/sooqna-backend/src/modules/reviews/reviews.service.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.producers.test.ts`

- [ ] **Step 1: Write failing producer integration tests**

Inject an `enqueue` dependency into each service. Assert a message emits once per participant except sender with dedupe `message:{messageId}:{recipientId}`; duplicate favorite does not enqueue; self-favorite does not enqueue; new favorite uses the owner/hour aggregation facts; review emits once with `review:{reviewId}:{sellerId}`. Assert the business result still succeeds when the post-success enqueue boundary fails and a structured error is logged without content.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/notifications.producers.test.ts`

Expected: FAIL because service constructors do not accept the producer.

- [ ] **Step 3: Make favorite insertion observable**

Change `FavoritesRepository.upsert(record): Promise<{ created: boolean }>` and implement with `findUnique` plus `create`; on unique conflict return `{ created: false }`. Preserve JSON fallback behavior with the same return contract. Only enqueue when `created` and `listing.ownerId !== userId`.

- [ ] **Step 4: Inject and call the producer at successful boundaries**

Use a default production dependency so existing controller construction remains valid:

```ts
type Enqueue = typeof enqueueNotificationEvent;
constructor(private readonly repo: MessagesRepository, private readonly enqueue: Enqueue = enqueueNotificationEvent) {}
```

For messages, pass conversation participant IDs, sender display name from `req.currentUser`, listing title, sanitized preview source, and conversation/message IDs. For reviews, pass reviewer ID, seller ID, listing ID, rating, and review ID. Catch only enqueue failures at legacy non-transactional boundaries, log IDs/type/outcome, and never swallow validation or persistence failures.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- --runInBand src/modules/notifications/notifications.producers.test.ts src/modules/messages/messages.identity.test.ts src/modules/reviews/reviews.routes.test.ts`

Expected: PASS.

```bash
git add backend/sooqna-backend/src/modules/messages backend/sooqna-backend/src/modules/favorites backend/sooqna-backend/src/modules/reviews backend/sooqna-backend/src/modules/notifications
git commit -m "feat: notify marketplace engagement events"
```

### Task 7: Produce listing lifecycle and saved-search notifications

**Files:**
- Create: `backend/sooqna-backend/src/modules/notifications/saved-search-matcher.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/listing-expiration.job.ts`
- Modify: `backend/sooqna-backend/src/modules/listings/listings.service.ts`
- Modify: `backend/sooqna-backend/src/modules/admin/admin.routes.ts`
- Modify: `backend/sooqna-backend/src/server.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/saved-search-matcher.test.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/listing-expiration.job.test.ts`
- Test: `backend/sooqna-backend/src/modules/admin/admin.routes.test.ts`

- [ ] **Step 1: Write failing matcher, expiration, and moderation tests**

Cover normalized q/category/city/price/condition matching, excluding the listing owner, deterministic saved-search hourly keys, expiring exactly once in the seven-day window, expired state plus event in one transaction, single and bulk approve/reject event rows, and safe rejection reason truncation.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/saved-search-matcher.test.ts src/modules/notifications/listing-expiration.job.test.ts src/modules/admin/admin.routes.test.ts`

Expected: FAIL for missing matcher/job/event rows.

- [ ] **Step 3: Implement canonical saved-search matching**

Export `matchesSavedSearch(listing, query)` using the same category/city normalization and price aliases (`minPrice|priceMin`, `maxPrice|priceMax`) used by public listing search. `enqueueSavedSearchMatches(listing, tx)` queries saved searches in batches of 200, filters with the pure matcher, excludes `userId === ownerId`, and upserts `SAVED_SEARCH_MATCHES` events with `saved-search:{searchId}:{userId}:{UTC-hour}`. The aggregate metadata retains at most the newest ten unique listing IDs plus an uncapped total count; repeated matches update the same row title, body, and count.

- [ ] **Step 4: Make moderation transactions emit owner events**

In both `moderateListing` and bulk moderation, select `ownerId/title/status`, then include `notificationOutbox.createMany({ skipDuplicates: true })` in the existing `prisma.$transaction`. Publish creates LISTING_APPROVED; reject creates LISTING_REJECTED with a reason capped at 240 characters. After a publish transaction, enqueue saved-search matches for the now-published listing.

- [ ] **Step 5: Implement listing expiration job**

`runListingExpirationJob(now, batchSize = 100)` first emits LISTING_EXPIRING for published listings whose `expiresAt` is in `(now, now+7d]` using a daily dedupe key. It then claims expired listings, transactionally archives each listing and creates LISTING_EXPIRED. Add a six-hour timer in `server.ts`, run once at startup, unref the timer, and clear it during shutdown.

- [ ] **Step 6: Run tests and commit**

Run the three focused test files, then `npm run typecheck`.

Expected: all PASS and typecheck exit 0.

```bash
git add backend/sooqna-backend/src/modules/notifications backend/sooqna-backend/src/modules/listings backend/sooqna-backend/src/modules/admin backend/sooqna-backend/src/server.ts
git commit -m "feat: notify listing lifecycle and saved searches"
```

### Task 8: Add durable admin broadcasts, retention cleanup, and metrics

**Files:**
- Modify: `backend/sooqna-backend/src/modules/notifications/notifications.routes.ts`
- Modify: `backend/sooqna-backend/src/modules/notifications/notifications.worker.ts`
- Create: `backend/sooqna-backend/src/modules/notifications/notifications.cleanup.ts`
- Create: `backend/sooqna-backend/scripts/cleanup-notifications.ts`
- Modify: `backend/sooqna-backend/src/modules/admin/admin.routes.ts`
- Modify: `backend/sooqna-backend/src/routes/index.ts`
- Modify: `backend/sooqna-backend/package.json`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.broadcast.test.ts`
- Test: `backend/sooqna-backend/src/modules/notifications/notifications.cleanup.test.ts`

- [ ] **Step 1: Write failing broadcast/resume/cleanup tests**

Assert ADMIN-only creation, audit metadata without copy, ALL/ROLES/USERS audience selection, batches of 200, cursor persistence after each batch, restart resume without duplicates, account status/role changes emitting mandatory SECURITY_ALERT events, expired or soft-deleted notification removal, 14-day processed outbox deletion, 30-day dead outbox deletion, and bounded cleanup batches.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --runInBand src/modules/notifications/notifications.broadcast.test.ts src/modules/notifications/notifications.cleanup.test.ts`

Expected: FAIL because broadcast and cleanup behavior is missing.

- [ ] **Step 3: Implement admin routes and fan-out**

Mount `POST /api/admin/notification-broadcasts` and `GET /api/admin/notification-broadcasts` inside the already protected `adminRouter`. Validate audience and internal URL, create PENDING broadcast, and call `logAuditEvent` with broadcast ID/audience only. Worker pages users by `firebaseUid`, creates per-user SYSTEM_ANNOUNCEMENT rows with dedupe `broadcast:{broadcastId}:{userId}`, updates cursor/count after every batch, and sets COMPLETED only after the last page.

When the existing admin user patch route changes `role` or `accountStatus`, include a SECURITY_ALERT outbox row in the same transaction with dedupe `security:user-change:{auditId}:{targetUserId}`. The payload contains the target user ID, Arabic title/body describing only the changed field, and `/me/settings`; SECURITY preference remains mandatory.

- [ ] **Step 4: Implement cleanup and aggregate diagnostics**

Delete notifications where `expiresAt <= now OR deletedAt IS NOT NULL` in loops of at most 500 using selected IDs until one batch is smaller than 500. Delete processed outbox rows older than 14 days and dead rows older than 30 days. Export counts only: pending outbox, oldest pending age, processed/failed/dead, active SSE, and cleanup totals. Add admin-protected `GET /api/admin/notifications/health` returning only those aggregates and add `notifications:cleanup` script: `tsx scripts/cleanup-notifications.ts`.

- [ ] **Step 5: Run tests and commit**

Run the focused tests and full backend `npm test -- --runInBand`.

Expected: all test suites PASS.

```bash
git add backend/sooqna-backend
git commit -m "feat: add notification broadcasts and retention"
```

### Task 9: Build the typed web client and authenticated stream parser

**Files:**
- Create: `apps/web/src/types/notification.ts`
- Modify: `apps/web/src/services/apiClient.ts`
- Create: `apps/web/src/services/notificationService.ts`
- Create: `apps/web/src/components/notifications/notificationStream.ts`
- Test: `apps/web/tests/notificationStream.test.ts`
- Test: `apps/web/tests/notificationService.test.ts`

- [ ] **Step 1: Write failing pure-client tests**

Use `node:assert/strict` like existing web tests. Cover split SSE chunks, comments/heartbeat ignored, `notification.changed` parsed, malformed JSON ignored, backoff capped at 30 seconds, visible state permits streaming, hidden state blocks it, and REST paths/methods match the API.

- [ ] **Step 2: Run and verify failure**

Run from `apps/web`: `npx tsx tests/notificationStream.test.ts && npx tsx tests/notificationService.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Define exact client DTOs and pure helpers**

```ts
export type NotificationCategory = "MESSAGES" | "LISTINGS" | "ENGAGEMENT" | "SAVED_SEARCHES" | "SYSTEM" | "SECURITY";
export type NotificationItemDto = {
  id: string; type: string; category: NotificationCategory; title: string; body: string;
  actionUrl: string | null; metadata: Record<string, unknown>; readAt: string | null; createdAt: string;
};
export type NotificationSignal = { event: "notification.changed"; notificationId: string; unreadCount: number; version: 1 };
```

Implement `SseParser.push(chunk): NotificationSignal[]`, `reconnectDelay(attempt, random)` using `min(30_000, 1_000 * 2**attempt) + floor(random()*500)`, and `shouldConnect({ user, visibilityState, online })`.

- [ ] **Step 4: Implement service operations and streaming fetch**

Use `apiFetch` for list/count/read/read-all/delete/preferences. Export `openNotificationStream({ signal, onSignal, onDisconnect })`: obtain `getAuthHeader()`, call `fetch(apiBase + "/notifications/stream", { headers: { Accept: "text/event-stream", ...authHeader }, signal })`, reject non-OK responses, read `response.body.getReader()`, decode incrementally, and never persist or log the token. Export `apiBase()` from `apiClient.ts` rather than duplicating environment logic.

- [ ] **Step 5: Run tests, lint, and commit**

Run both Node tests, then `npm run lint`.

Expected: tests complete without assertion output; lint exit 0.

```bash
git add apps/web/src/types/notification.ts apps/web/src/services apps/web/src/components/notifications/notificationStream.ts apps/web/tests/notificationStream.test.ts apps/web/tests/notificationService.test.ts
git commit -m "feat: add notification web client"
```

### Task 10: Add the notification provider and optimistic state

**Files:**
- Create: `apps/web/src/contexts/notification-context.tsx`
- Create: `apps/web/src/components/notifications/notificationState.ts`
- Modify: `apps/web/src/app/providers.tsx`
- Test: `apps/web/tests/notificationState.test.ts`

- [ ] **Step 1: Write failing reducer and lifecycle tests**

Assert HYDRATE, SIGNAL_COUNT, MARK_READ_OPTIMISTIC, MARK_READ_ROLLBACK, MARK_ALL, DELETE_OPTIMISTIC, DELETE_ROLLBACK, logout reset, and no negative unread counts. Test that visibility restoration triggers REST refresh before reopening and only one connection runner can be active.

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx tests/notificationState.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement reducer and provider**

The reducer state is `{ items, unreadCount, loading, error, reconnecting }`. The provider watches `currentUser`, `document.visibilitychange`, `online`, and `offline`; aborts the stream on logout/hidden/offline/unmount; refetches count/latest on signal and reconnect; uses a single-flight promise; and resets reconnect attempt after a successful response. Expose:

```ts
type NotificationContextValue = NotificationState & {
  refresh(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  remove(id: string): Promise<void>;
};
```

Optimistic operations capture the prior state, dispatch the optimistic action, call the service, then dispatch rollback plus Arabic recoverable error on failure.

- [ ] **Step 4: Mount provider in auth scope and verify**

```tsx
<AuthProvider>
  <NotificationProvider>
    <ThemeProvider>{children}</ThemeProvider>
  </NotificationProvider>
</AuthProvider>
```

Run `npx tsx tests/notificationState.test.ts` and `npm run lint`.

Expected: PASS and lint exit 0.

- [ ] **Step 5: Commit provider**

```bash
git add apps/web/src/contexts apps/web/src/components/notifications/notificationState.ts apps/web/src/app/providers.tsx apps/web/tests/notificationState.test.ts
git commit -m "feat: manage live notification state"
```

### Task 11: Implement the rich bell and popover

**Files:**
- Create: `apps/web/src/components/notifications/NotificationBell.tsx`
- Create: `apps/web/src/components/notifications/NotificationPopover.tsx`
- Create: `apps/web/src/components/notifications/NotificationItem.tsx`
- Create: `apps/web/src/components/notifications/notificationPresentation.ts`
- Modify: `apps/web/src/components/layout/PublicNavActions.tsx`
- Modify: `apps/web/src/components/layout/PublicShell.tsx`
- Test: `apps/web/tests/notificationPresentation.test.ts`

- [ ] **Step 1: Write failing presentation tests**

Assert known type icon/label/color mappings, unknown type generic fallback, badge values `0 -> null`, `4 -> "4"`, `100 -> "99+"`, relative-time grouping, and action URLs accepted only when they start with one slash and not two.

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx tests/notificationPresentation.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement shared item and presentation mapping**

`NotificationItem` renders category icon, title, body, `<time dateTime>`, unread dot, and an overflow delete button. Clicking the item calls `markRead` then `router.push(safeActionUrl ?? "/notifications")`. Keyboard Enter/Space invokes the same action. Unknown types use bell icon, neutral color, and label `إشعار`.

- [ ] **Step 4: Implement accessible bell/popover and integrate nav**

The bell button has `aria-label="الإشعارات"`, `aria-expanded`, `aria-controls`, and a visually hidden `aria-live="polite"` count. Popover has All/Unread tabs, latest eight filtered items, loading/error/empty states, `تحديد الكل كمقروء`, settings link `/me/settings#notifications`, and center link `/notifications`. Escape closes, outside click closes, focus returns to bell, and RTL alignment remains inside viewport. Render `<NotificationBell />` beside the signed-in avatar in `PublicNavActions`; also render it in the mobile-only header controls in `PublicShell` because `PublicNavActions` is hidden below `md`.

- [ ] **Step 5: Verify and commit**

Run the presentation test and `npm run lint`.

Expected: PASS and lint exit 0.

```bash
git add apps/web/src/components/notifications apps/web/src/components/layout/PublicNavActions.tsx apps/web/src/components/layout/PublicShell.tsx apps/web/tests/notificationPresentation.test.ts
git commit -m "feat: add rich notification popover"
```

### Task 12: Implement the full center, mobile entry, and preferences

**Files:**
- Create: `apps/web/src/app/notifications/page.tsx`
- Create: `apps/web/src/components/notifications/NotificationCenter.tsx`
- Create: `apps/web/src/components/notifications/NotificationPreferences.tsx`
- Modify: `apps/web/src/components/me/AccountSettingsForm.tsx`
- Modify: `apps/web/src/components/layout/BottomNav.tsx`
- Test: `apps/web/tests/notificationCenterState.test.ts`

- [ ] **Step 1: Write failing center-state tests**

Cover Today/Yesterday/Earlier grouping in local time, category + unread filters, stable cursor append without duplicates, locked SYSTEM/SECURITY preferences, optional toggle rollback, and mobile route active state.

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx tests/notificationCenterState.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Build the protected notification center**

The page uses `PublicShell`, redirects signed-out users to `/login?next=%2Fnotifications`, and renders `NotificationCenter`. Desktop uses category sidebar; mobile uses horizontal chips. Implement All/Unread, grouped headings, 20-item cursor pages with `تحميل المزيد`, per-item read/delete, mark-all, loading skeleton, empty copy, reconnect/offline banner, retry button, and no infinite fetch loop.

- [ ] **Step 4: Build and mount preferences**

Fetch preferences on mount. Render enabled toggles for MESSAGES/LISTINGS/ENGAGEMENT/SAVED_SEARCHES and checked disabled controls for SYSTEM/SECURITY with `إشعارات النظام والأمان إلزامية`. If the preference read fails, show a settings warning while displaying optional categories as enabled by default. Save the complete optional preference object with PUT, optimistically update, and rollback plus Arabic error on failure. Add `id="notifications"` section in `AccountSettingsForm`.

- [ ] **Step 5: Add mobile navigation and verify responsive UI**

Add a signed-in notification link/button in `BottomNav` with the shared unread badge and active path logic. At 375px ensure chips scroll horizontally without page overflow; at 1280px ensure the sidebar and list remain within the 1110px shell.

Run `npx tsx tests/notificationCenterState.test.ts`, `npm run lint`, and `npm run build` with required production validation environment configured.

Expected: test/lint PASS and Next build completes.

- [ ] **Step 6: Commit center and preferences**

```bash
git add apps/web/src/app/notifications apps/web/src/components/notifications apps/web/src/components/me/AccountSettingsForm.tsx apps/web/src/components/layout/BottomNav.tsx apps/web/tests/notificationCenterState.test.ts
git commit -m "feat: add notification center and preferences"
```

### Task 13: Add end-to-end flows and complete verification

**Files:**
- Create: `apps/web/tests/e2e/notifications.spec.ts`
- Modify: `apps/web/playwright.config.ts` only if the existing webServer setup cannot start both applications.
- Modify: `docs/superpowers/specs/2026-08-24-in-app-notification-system-design.md` only to record an implementation note if production proxy behavior differs from the approved assumptions.

- [ ] **Step 1: Write the message notification E2E test**

Seed or create two Firebase test users, a published listing, and a conversation. Send a message as buyer, sign in as seller, open the bell, assert the sanitized preview, click it, assert `/messages?conversation=<id>`, and verify unread count decreases. Use stable `data-testid` values `notification-bell`, `notification-count`, `notification-popover`, and `notification-item-<id>`.

- [ ] **Step 2: Write the moderation notification E2E test**

Create a pending listing as seller, approve it through authenticated admin API setup, sign in as seller, assert `تم قبول إعلانك`, navigate to the listing action URL, and repeat with rejection to assert the safe reason summary.

- [ ] **Step 3: Run E2E tests and resolve only notification regressions**

Run from `apps/web`: `npx playwright test tests/e2e/notifications.spec.ts --project=chromium`

Expected: both flows PASS. Preserve traces/screenshots only for failures.

- [ ] **Step 4: Run the complete verification matrix**

Backend from `backend/sooqna-backend`:

```bash
npx prisma validate
npm run typecheck
npm test -- --runInBand
npm run build
```

Web from `apps/web`:

```bash
npx tsx tests/notificationStream.test.ts
npx tsx tests/notificationService.test.ts
npx tsx tests/notificationState.test.ts
npx tsx tests/notificationPresentation.test.ts
npx tsx tests/notificationCenterState.test.ts
npm run lint
npm run build
npx playwright test tests/e2e/notifications.spec.ts --project=chromium
```

Expected: every command exits 0. Confirm manually that REST recovery works with SSE disconnected, hidden tabs have zero active stream, Nginx returns `X-Accel-Buffering: no`, and notification content/tokens do not appear in logs.

- [ ] **Step 5: Review migration and rollout safety**

Run `git diff main...HEAD -- backend/sooqna-backend/prisma` and verify only additive tables/enums/indexes/relations. Run cleanup against staging with a dry diagnostic count first. Confirm the worker can be disabled without preventing marketplace writes and the UI remains usable through REST.

- [ ] **Step 6: Commit E2E coverage**

```bash
git add apps/web/tests/e2e/notifications.spec.ts apps/web/playwright.config.ts docs/superpowers/specs/2026-08-24-in-app-notification-system-design.md
git commit -m "test: cover notification user journeys"
```

---

## Completion criteria

- Every approved notification type has one centralized template and at least one producer integration test.
- User REST queries and mutations are owner-scoped, expired/deleted rows are excluded, and action URLs are internal.
- Outbox retries survive restart, dedupe keys prevent duplicates, attempt eight dead-letters, and aggregates update in place.
- SSE uses Bearer authentication, emits content-free signals, heartbeats, respects per-user caps, and cleans up hidden/closed clients.
- Bell, rich popover, full center, mobile entry, preferences, RTL, keyboard access, offline/reconnect, and optimistic rollback are verified.
- Retention, broadcast resume, audit logging, metrics, full backend/web builds, and both Playwright journeys pass.
