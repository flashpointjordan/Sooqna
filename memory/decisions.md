# Decisions & rationale

Why things are the way they are. Saves re-litigating settled calls.

## Identity: Firebase Auth for identity only, Postgres for data
Firebase verifies who the user is (server verifies the ID token). All business data (users,
listings, messages, …) lives in Postgres via Prisma — the source of truth. A backend `User` row is
created/synced from the Firebase token on first authenticated call (`ensureUserProfile` →
`POST /users/profile`). This sync is **best-effort on login**: Firebase auth already succeeded, so a
sync failure must not be re-thrown as a login error.

## Email verification gates actions, not browsing
`REQUIRE_EMAIL_VERIFIED` defaults true in prod. Unverified users can browse, but posting listings,
uploading, messaging, favorites, and reviews require a verified email. Rationale: reduce spam/abuse
on a public marketplace while keeping discovery open.

## Listings are moderated before going public
Publishing sets status `pending`; an admin approves before it appears in search/listings. Trades
instant publishing for trust/safety. New users' listings are not immediately visible — relevant when
testing flows that depend on a listing being public (e.g. buyer messaging a seller).

## No online payments yet
reCAPTCHA is disabled in prod and paid/"featured" packages are "coming soon" (no checkout). The
`/packages` page states this. Don't wire payment-dependent flows as if checkout exists.

## CORS trailing-slash normalization
Configured origins are normalized (strip trailing slash) so the allowlist matches the browser
`Origin` regardless of how the `NEXT_PUBLIC_SITE_URL` secret is written — chosen over relying on
perfectly-clean secrets. See `known-issues.md`.

## Arabic-aware search via a stored normalized column
Search folds alef/yaa/taa variants + diacritics. Implemented by storing a normalized `searchText`
(title + description) on each listing and matching a normalized query against it, rather than
normalizing on the fly in SQL (keeps one JS normalizer as source of truth; avoids fragile SQL
Unicode handling and a risky in-migration backfill).
