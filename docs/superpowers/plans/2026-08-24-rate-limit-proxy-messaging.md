# Rate-limit Proxy and Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each production client an independent rate-limit bucket behind Nginx, reduce messaging polling traffic, and stop inappropriate retries of HTTP 429 and other client errors.

**Architecture:** Keep the existing Express rate-limit policies but configure one trusted proxy hop and centralize privacy-safe rejection logging. Introduce a typed web API error and a small retry policy module, then make messaging reads use that policy while writes remain single-attempt. Extract small polling primitives so single-flight, page visibility, and 429 cooldown behavior can be tested without a React test runner.

**Tech Stack:** Express 4, express-rate-limit 7, TypeScript 5.7, Jest/Supertest, Next.js 15, React 19, Node assert tests, GitHub Actions, Nginx, PM2.

---

## File map

- Create `backend/sooqna-backend/src/config/trustProxy.ts`: parse and validate the Express trust-proxy value without loading the rest of the environment.
- Create `backend/sooqna-backend/src/config/trustProxy.test.ts`: pure unit coverage for production proxy validation.
- Create `backend/sooqna-backend/src/middleware/rateLimitProxy.test.ts`: integration coverage proving forwarded clients receive independent buckets.
- Modify `backend/sooqna-backend/src/config/env.ts`: consume the tested proxy parser and validator.
- Modify `.github/workflows/deploy.yml`: write `TRUST_PROXY=1` into the generated production backend environment.
- Create `backend/sooqna-backend/src/middleware/rateLimitHandler.ts`: construct named, privacy-safe 429 handlers.
- Create `backend/sooqna-backend/src/middleware/rateLimitHandler.test.ts`: verify response and diagnostic metadata.
- Modify `backend/sooqna-backend/src/app.ts`: attach named handlers without changing thresholds.
- Create `apps/web/src/services/apiRequestError.ts`: typed HTTP/network error metadata and retry classification.
- Create `apps/web/src/services/requestRetry.ts`: bounded retry helper with injectable delay for tests.
- Create `apps/web/tests/requestRetry.test.ts`: Node assertions for 429, 4xx, 5xx, network failures, and retry limits.
- Modify `apps/web/src/services/apiClient.ts`: throw typed errors and preserve `Retry-After`.
- Modify `apps/web/src/services/messageService.ts`: retry safe reads only and leave writes single-attempt.
- Create `apps/web/src/components/messages/messagePolling.ts`: pure cooldown/visibility checks and a single-flight runner.
- Create `apps/web/tests/messagePolling.test.ts`: Node assertions for hidden tabs, cooldown, and overlapping cycles.
- Modify `apps/web/src/components/messages/MessagesWorkspace.tsx`: 30-second, visible-tab, non-overlapping polling with no nested inbox refresh.

### Task 1: Production trust-proxy configuration

**Files:**
- Create: `backend/sooqna-backend/src/config/trustProxy.ts`
- Create: `backend/sooqna-backend/src/config/trustProxy.test.ts`
- Create: `backend/sooqna-backend/src/middleware/rateLimitProxy.test.ts`
- Modify: `backend/sooqna-backend/src/config/env.ts`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the failing trust-proxy tests**

Create `trustProxy.test.ts` with cases equivalent to:

```ts
import { parseTrustProxy, validateProductionTrustProxy } from "./trustProxy";

describe("trust proxy configuration", () => {
  it("parses one trusted proxy hop", () => {
    expect(parseTrustProxy("1")).toBe(1);
  });

  it("rejects a disabled proxy in production", () => {
    expect(() => validateProductionTrustProxy("production", false)).toThrow(
      /TRUST_PROXY must be enabled/
    );
  });

  it("allows a disabled proxy outside production", () => {
    expect(() => validateProductionTrustProxy("test", false)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `backend/sooqna-backend`:

```powershell
npm test -- --runInBand src/config/trustProxy.test.ts
```

Expected: FAIL because `./trustProxy` does not exist.

- [ ] **Step 3: Implement the pure parser and production guard**

Create `trustProxy.ts`:

```ts
export type TrustProxyValue = boolean | number | string;

export function parseTrustProxy(value: string | undefined): TrustProxyValue {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  return value.trim();
}

export function validateProductionTrustProxy(
  nodeEnv: string,
  trustProxy: TrustProxyValue
): void {
  if (nodeEnv === "production" && trustProxy === false) {
    throw new Error("TRUST_PROXY must be enabled in production behind Nginx.");
  }
}
```

In `env.ts`, remove the local `parseTrustProxy`, calculate `trustProxy` once using the imported function, call `validateProductionTrustProxy(nodeEnv, trustProxy)`, and expose that value on `env`.

In `.github/workflows/deploy.yml`, add this line beside `NODE_ENV=production` and `PORT=5000`:

```bash
echo "TRUST_PROXY=1"
```

- [ ] **Step 4: Run focused tests and typecheck**

Before running, create `rateLimitProxy.test.ts` as the regression test for the production failure:

```ts
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";

describe("rate limiting behind one trusted proxy", () => {
  it("keeps forwarded client buckets independent", async () => {
    const testApp = express();
    testApp.set("trust proxy", 1);
    testApp.use(rateLimit({ windowMs: 60_000, max: 1 }));
    testApp.get("/test", (_req, res) => res.sendStatus(200));

    const first = await request(testApp).get("/test").set("X-Forwarded-For", "203.0.113.1");
    const firstAgain = await request(testApp).get("/test").set("X-Forwarded-For", "203.0.113.1");
    const second = await request(testApp).get("/test").set("X-Forwarded-For", "203.0.113.2");

    expect(first.status).toBe(200);
    expect(firstAgain.status).toBe(429);
    expect(second.status).toBe(200);
  });
});
```

```powershell
npm test -- --runInBand src/config/trustProxy.test.ts src/middleware/rateLimitProxy.test.ts
npm run typecheck
```

Expected: all trust-proxy tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add -- .github/workflows/deploy.yml backend/sooqna-backend/src/config/env.ts backend/sooqna-backend/src/config/trustProxy.ts backend/sooqna-backend/src/config/trustProxy.test.ts backend/sooqna-backend/src/middleware/rateLimitProxy.test.ts
git commit -m "fix: trust production proxy addresses"
```

### Task 2: Named, privacy-safe rate-limit diagnostics

**Files:**
- Create: `backend/sooqna-backend/src/middleware/rateLimitHandler.ts`
- Create: `backend/sooqna-backend/src/middleware/rateLimitHandler.test.ts`
- Modify: `backend/sooqna-backend/src/app.ts`

- [ ] **Step 1: Write a failing handler test**

Test a handler with a stub request/response and a mocked logger. Assert that it returns status 429 with the configured body and calls `logger.warn("rate_limit_exceeded", ...)` with only `limiter`, `method`, `path`, `clientIp`, and `retryAfter`.

Use this expected shape:

```ts
expect(logger.warn).toHaveBeenCalledWith("rate_limit_exceeded", {
  limiter: "messages",
  method: "GET",
  path: "/api/messages/conversations",
  clientIp: "203.0.113.7",
  retryAfter: "30",
});
```

Also assert the logged object contains none of `authorization`, `body`, `email`, or `token`.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm test -- --runInBand src/middleware/rateLimitHandler.test.ts
```

Expected: FAIL because the handler module does not exist.

- [ ] **Step 3: Implement the named handler**

Implement a factory with this public interface:

```ts
import type { RateLimitExceededEventHandler } from "express-rate-limit";

export function createRateLimitHandler(
  limiter: string,
  body: Record<string, unknown>
): RateLimitExceededEventHandler;
```

The handler must read `res.getHeader("Retry-After")`, log only the approved fields through `logger.warn`, and respond with `res.status(429).json(body)`.

In `app.ts`, add `handler: createRateLimitHandler("general", body)` (and the matching names `auth`, `reports`, `messages`, `favorites`, `listings-read`, `listings-write`, `admin`, and `contact`) to each current limiter. Keep every existing `windowMs`, `max`, `skip`, standard header, and response message unchanged.

- [ ] **Step 4: Run handler test, health test, and typecheck**

```powershell
npm test -- --runInBand src/middleware/rateLimitHandler.test.ts src/routes/health.test.ts
npm run typecheck
```

Expected: tests PASS; health remains 200; TypeScript exits 0.

- [ ] **Step 5: Commit only Task 2 files**

```powershell
git add -- backend/sooqna-backend/src/app.ts backend/sooqna-backend/src/middleware/rateLimitHandler.ts backend/sooqna-backend/src/middleware/rateLimitHandler.test.ts
git commit -m "feat: log named rate-limit rejections"
```

### Task 3: Typed API errors and safe retry policy

**Files:**
- Create: `apps/web/src/services/apiRequestError.ts`
- Create: `apps/web/src/services/requestRetry.ts`
- Create: `apps/web/tests/requestRetry.test.ts`
- Modify: `apps/web/src/services/apiClient.ts`
- Modify: `apps/web/src/services/messageService.ts`

- [ ] **Step 1: Write failing retry-policy assertions**

Create a Node assertion test covering these exact behaviors:

```ts
assert.equal(isRetryableRequestError(new ApiRequestError("limited", 429, "RATE_LIMITED", 35)), false);
assert.equal(isRetryableRequestError(new ApiRequestError("bad", 400, "BAD_REQUEST")), false);
assert.equal(isRetryableRequestError(new ApiRequestError("busy", 503, "UNAVAILABLE")), true);
assert.equal(isRetryableRequestError(new TypeError("fetch failed")), true);
assert.equal(parseRetryAfterSeconds("35"), 35);
assert.equal(parseRetryAfterSeconds("invalid"), null);
```

Use an injected zero-delay function and an attempt counter to assert `withRetry` makes three total attempts for a retryable failure when `retries: 2`, and exactly one attempt for 429.

- [ ] **Step 2: Run the test and verify RED**

From `apps/web`:

```powershell
npx tsx tests/requestRetry.test.ts
```

Expected: FAIL because the API error and retry modules do not exist.

- [ ] **Step 3: Implement error metadata and retry classification**

`ApiRequestError` must expose this stable interface:

```ts
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null = null,
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
```

Export `parseRetryAfterSeconds(value: string | null): number | null`, accepting only finite, non-negative integer seconds. `isRetryableRequestError` returns true only for a `TypeError` network failure, an `ApiRequestError` with code `REQUEST_TIMEOUT`, or status 500, 502, 503, or 504. `withRetry` accepts `{ retries, delayMs, sleep }`, uses this classifier, and stops immediately for non-retryable failures.

Update `apiFetch` so non-OK responses throw `ApiRequestError`; parse numeric `Retry-After`, preserve the existing Arabic 429 message, and convert aborts to an error with code `REQUEST_TIMEOUT`. Do not lose the original HTTP status or application code.

- [ ] **Step 4: Restrict automatic retries to safe messaging reads**

In `messageService.ts`, import `withRetry` instead of defining it locally. Keep it around `getConversationById`, `getMyConversations`, `getConversationMessages`, and `getUnreadSummary`.

Call `apiFetch` directly, with no automatic retry, from `createConversation`, `createMessage`, and `markConversationRead`. This prevents duplicate writes after ambiguous failures.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

```powershell
npx tsx tests/requestRetry.test.ts
npx tsc --noEmit
npm run lint
```

Expected: retry test completes with no assertion output; TypeScript and ESLint exit 0.

- [ ] **Step 6: Commit only Task 3 files**

```powershell
git add -- apps/web/src/services/apiClient.ts apps/web/src/services/apiRequestError.ts apps/web/src/services/messageService.ts apps/web/src/services/requestRetry.ts apps/web/tests/requestRetry.test.ts
git commit -m "fix: respect API retry semantics"
```

### Task 4: Testable polling controls

**Files:**
- Create: `apps/web/src/components/messages/messagePolling.ts`
- Create: `apps/web/tests/messagePolling.test.ts`

- [ ] **Step 1: Write failing polling assertions**

Cover these behaviors with Node assertions:

```ts
assert.equal(canPollMessages({ visibilityState: "hidden", blockedUntil: 0, now: 100 }), false);
assert.equal(canPollMessages({ visibilityState: "visible", blockedUntil: 200, now: 100 }), false);
assert.equal(canPollMessages({ visibilityState: "visible", blockedUntil: 100, now: 100 }), true);
```

Create a deferred promise, invoke the same single-flight runner twice before resolving it, and assert the task ran once and the second call returned `false`. After resolution, assert a third call runs normally.

Assert `getRateLimitBlockedUntil(new ApiRequestError("limited", 429, "RATE_LIMITED", 35), 1_000)` returns `36_000`, while a non-429 error returns `null`.

- [ ] **Step 2: Run the test and verify RED**

```powershell
npx tsx tests/messagePolling.test.ts
```

Expected: FAIL because `messagePolling.ts` does not exist.

- [ ] **Step 3: Implement the polling primitives**

Export these functions:

```ts
export function canPollMessages(input: {
  visibilityState: DocumentVisibilityState;
  blockedUntil: number;
  now: number;
}): boolean;

export function getRateLimitBlockedUntil(error: unknown, now: number): number | null;

export function createSingleFlightRunner(): <T>(task: () => Promise<T>) => Promise<boolean>;

export async function refreshMessagePollCycle(input: {
  conversationId: string;
  refreshInbox: () => Promise<UnreadSummary>;
  refreshConversation: (conversationId: string) => Promise<void>;
  markRead: (conversationId: string) => Promise<number>;
  applyReadState: (conversationId: string, unreadCount: number) => void;
}): Promise<void>;
```

The runner resets its in-flight flag in `finally`, including when the task rejects. `refreshMessagePollCycle` calls `refreshInbox` exactly once, calls `refreshConversation` exactly once when an ID exists, and calls `markRead` plus `applyReadState` only when the returned summary reports a positive unread count for that conversation. Add assertions with injected counters proving these call counts.

- [ ] **Step 4: Run the focused test and web typecheck**

```powershell
npx tsx tests/messagePolling.test.ts
npx tsc --noEmit
```

Expected: assertions and typecheck pass.

- [ ] **Step 5: Commit only Task 4 files**

```powershell
git add -- apps/web/src/components/messages/messagePolling.ts apps/web/tests/messagePolling.test.ts
git commit -m "test: define messaging polling controls"
```

### Task 5: Integrate efficient messaging polling

**Files:**
- Modify: `apps/web/src/components/messages/MessagesWorkspace.tsx`

- [ ] **Step 1: Establish the failing source-level expectation**

Before editing, verify the current source still contains both the 20-second interval and nested inbox refresh:

```powershell
Select-String -Path src/components/messages/MessagesWorkspace.tsx -Pattern '20_000|await refreshInbox\(\)'
```

Expected: both patterns are present.

- [ ] **Step 2: Integrate a 30-second single-flight cycle**

Set `POLL_INTERVAL_MS = 30_000`. Create stable refs for the single-flight runner and `blockedUntil`. A poll cycle must:

1. return without work when the tab is hidden or the 429 cooldown has not expired;
2. run `refreshInbox()` and the active conversation read refresh once each;
3. skip if another cycle is in flight;
4. store the 429 block time returned by `getRateLimitBlockedUntil`.

Remove `await refreshInbox()` and `markConversationRead()` from `refreshConversationData`; that function will only fetch conversation metadata and messages. Make `refreshInbox` return the fetched `UnreadSummary` after updating inbox state. The guarded refresh uses `refreshMessagePollCycle`, passing `refreshInbox`, `refreshConversationData`, `markConversationRead`, and a local-state callback. That callback subtracts the marked count from `unreadTotal` and sets the matching inbox item's `unreadCount` to zero without issuing a second inbox request.

Add a `visibilitychange` listener that runs one immediate guarded refresh when the document becomes visible. Keep explicit user refresh and post-send refresh behavior, but route them through the same guard where they can overlap polling.

- [ ] **Step 3: Verify request count and behavior statically**

```powershell
Select-String -Path src/components/messages/MessagesWorkspace.tsx -Pattern '20_000|await refreshInbox\(\)'
Select-String -Path src/components/messages/MessagesWorkspace.tsx -Pattern '30_000|visibilitychange|createSingleFlightRunner'
```

Expected: `20_000` and the nested call are absent; all three new controls are present.

- [ ] **Step 4: Run polling/retry tests, typecheck, and lint**

```powershell
npx tsx tests/messagePolling.test.ts
npx tsx tests/requestRetry.test.ts
npx tsc --noEmit
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the integration**

```powershell
git add -- apps/web/src/components/messages/MessagesWorkspace.tsx
git commit -m "fix: reduce messaging polling traffic"
```

### Task 6: Full verification and production handoff

**Files:**
- Modify only if results require a scoped correction to files already listed above.

- [ ] **Step 1: Run the complete backend verification**

From `backend/sooqna-backend`:

```powershell
npm run typecheck
npm test -- --runInBand
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Run the complete web verification**

From `apps/web`:

```powershell
npx tsx tests/requestRetry.test.ts
npx tsx tests/messagePolling.test.ts
npm run lint
npx tsc --noEmit
```

Expected: every command exits 0. Do not run `npm run build` if the Next development server is active; otherwise run the production build with the documented required public environment variables.

- [ ] **Step 3: Review the final diff and repository state**

```powershell
git diff --check
git status --short
git log -6 --oneline
```

Expected: no whitespace errors; only pre-existing unrelated user changes remain unstaged; the task commits are visible.

- [ ] **Step 4: Deploy through the existing main workflow**

Push/merge according to the user's chosen integration flow. The workflow regenerates the backend `.env`, applies `TRUST_PROXY=1`, and restarts PM2 with `--update-env`. No database migration is involved.

- [ ] **Step 5: Verify production after deployment**

Request `/api/health` and `/api/listings` from two independent networks. Confirm both return 200 and that one network's request no longer decrements the other network's remaining counter. Open a conversation for at least two polling cycles and confirm there are no duplicated inbox calls, no overlapping refreshes, and no immediate retry after a forced/test 429.

- [ ] **Step 6: Record final evidence**

Report the exact verification commands, pass/fail results, production header observations, commit IDs, and any intentionally deferred Redis/distributed-limiter work.
