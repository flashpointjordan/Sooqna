# Rate-limit, proxy, and messaging request design

Date: 2026-08-24
Status: Approved for implementation

## Goal

Stop legitimate Sooqna users from sharing one rate-limit counter behind Nginx, reduce avoidable messaging traffic, and make retries respect HTTP semantics without weakening abuse protection.

## Confirmed production behavior

- `https://sooqna.shop` is served through Nginx.
- The general API limiter exposes a policy of 500 requests per 15 minutes.
- Requests made from two independent networks consumed the same remaining-request counter.
- The main deployment workflow rewrites the production backend `.env` but does not write `TRUST_PROXY=1`.
- The messages screen currently polls every 20 seconds and can issue seven API calls per cycle when a conversation is open.
- Messaging retries all failures, including HTTP 429, up to two additional times.

## Scope

### Included

1. Configure one trusted reverse-proxy hop in the main production deployment.
2. Fail production configuration validation when `TRUST_PROXY` is disabled.
3. Preserve the current rate-limit thresholds initially.
4. Reduce and de-duplicate messaging polling requests.
5. Prevent overlapping polling cycles and pause polling in hidden tabs.
6. Retry only transient network/server failures, never ordinary 4xx responses or HTTP 429.
7. Preserve and expose `Retry-After` information to the UI.
8. Add focused automated tests for proxy identity, retry policy, and polling behavior where practical.
9. Add privacy-safe diagnostics for rate-limit events.

### Excluded

- Disabling rate limits.
- Raising limits before post-fix production observations exist.
- Adding Redis or another distributed counter store while the backend is a single PM2 process.
- Changing authentication, authorization, or verified-email rules.
- Adding OpenAI or Gemini; neither provider participates in this request path.

## Design

### Production proxy configuration

The main deploy workflow will write `TRUST_PROXY=1` into the backend `.env`. Express will therefore trust exactly one reverse-proxy hop and derive the client address from Nginx's forwarded address rather than treating Nginx itself as every caller.

The environment parser will require a non-false `TRUST_PROXY` value in production. This project always places the production backend behind Nginx, so failing at startup is safer than silently creating a global rate-limit bucket.

The existing general and route-specific thresholds remain unchanged. This keeps brute-force and abuse controls intact while isolating counters by client address.

### Messaging polling

Polling will run every 30 seconds. One refresh cycle will fetch the inbox/unread summary once and, when a conversation is selected, fetch its metadata and messages once. The conversation refresh must not call a second inbox refresh internally.

Only one cycle may run at a time. If the previous cycle is still active when the next interval fires, the new cycle is skipped. Polling pauses while `document.visibilityState` is not `visible` and resumes with an immediate refresh when the tab becomes visible.

The read endpoint will be called only when the active conversation has unread messages for the current user. User-triggered actions such as sending a message or pressing refresh may still request an immediate refresh, but they use the same in-flight guard.

### Error and retry model

`apiFetch` will throw a typed API error containing at least HTTP status, application code, and parsed `Retry-After` seconds when available. Existing user-facing Arabic messages remain available through the error's message.

The retry helper will retry only:

- network failures where no HTTP response was received;
- request timeouts when retrying the operation is safe;
- HTTP 500, 502, 503, and 504 responses.

It will not retry HTTP 400-499 responses. HTTP 429 is returned immediately to the caller with its retry delay. Polling will suppress further refreshes until that delay has elapsed instead of generating another burst.

Write operations will not be retried automatically unless they are already protected by an idempotency mechanism. This prevents duplicated messages or state changes after ambiguous network failures.

### Rate-limit diagnostics

Rate-limit handlers will log a compact structured warning containing the limiter name, method, normalized route/path, resolved client IP, and retry-after value. Authorization headers, request bodies, Firebase tokens, email addresses, and message contents will never be logged.

## Tests

Backend tests will verify that two different forwarded client addresses have independent rate-limit buckets when one proxy hop is trusted, while repeated requests from one address share a bucket. Production environment validation will cover missing or disabled `TRUST_PROXY`.

Frontend/service tests will verify that:

- HTTP 429 is not retried;
- eligible transient failures are retried within the configured limit;
- `Retry-After` is parsed and preserved;
- a polling cycle does not start while another is active;
- hidden tabs do not poll;
- one conversation cycle does not duplicate inbox calls.

Existing backend and web typechecks/tests must remain green.

## Deployment and verification

Deploy through the existing workflow so the production `.env` is regenerated with `TRUST_PROXY=1`, then restart PM2 with updated environment values. Verify:

1. Health and listing endpoints still return 200.
2. Requests from separate networks no longer consume the same rate-limit counter.
3. Messaging remains responsive in one and multiple tabs.
4. 429 responses display the wait time and are not immediately retried.
5. Authentication and sensitive-route limits remain active.

If proxy address resolution is incorrect after deployment, revert the deployment commit and restore the previous PM2 environment. No database migration or irreversible data change is involved.
