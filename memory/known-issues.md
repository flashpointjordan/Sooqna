# Known issues & gotchas

Check here before debugging "weird" behavior. Newest/most-important first.

## Generic errors usually mean a backend/DB failure, not a frontend bug
- The web client maps any thrown error **without a Firebase `code`** to the Arabic
  "حدث خطأ غير متوقع. حاول مرة أخرى." So a 500 from any backend call during login/signup shows
  as a generic "unexpected error". Check the actual network response, not just the UI text.
- On the backend, repositories wrap Prisma errors in a plain `Error`, which the error handler
  turns into a generic **500 "Internal server error."** So "Internal server error" on a page
  almost always = a failing DB query (missing column, failed migration, write failure), not a
  bug in that page.

## CORS exact-origin matching (caused a real prod login outage)
- `app.ts` allows origins via exact-string match against `env.corsOrigins`. Browsers send `Origin`
  **without** a trailing slash. The `NEXT_PUBLIC_SITE_URL` secret was set with a trailing slash, so
  `CORS_ORIGIN` didn't match the real origin → backend rejected its own site on every browser POST
  (recaptcha-verify, profile sync, etc.) → generic 500 → login showed "unexpected error".
- Fixed in `env.ts` by stripping trailing slashes from configured origins. If you add origins,
  they're normalized — but keep secrets clean anyway. **curl without an `Origin` header won't
  reproduce CORS bugs; test from a real browser.**

## Migration safety (P3009 risk)
- A failed `prisma migrate deploy` leaves the DB in a blocked state where **every** query fails →
  total 500 outage. Causes seen/avoided: non-idempotent `CREATE INDEX` / `DROP INDEX` on a drifted
  DB, and heavy data backfills inside a migration.
- Rule: migrations = simple DDL only. Data backfills live in `scripts/` and run as best-effort,
  non-fatal deploy steps (see `scripts/backfill-search-text.ts`).

## Schema drift
- The Prisma schema once declared columns (`soldAt`, `archivedAt`) + indexes with no matching
  migration, so prod was missing them → listing reads 500'd. If you add fields to `schema.prisma`,
  always generate the migration. Verify `npx prisma migrate status` on issues.

## Open / future
- **Image upload requires a real file**: the automation `file_upload` tool only accepts
  session-shared files; the listing form's image step needs an actual image. Publishing requires
  ≥1 image. (Verified-email gate also applies to uploads.)
- **Arabic search**: normalization now folds alef/yaa/taa/diacritics (`shared/utils/arabic.ts`,
  `searchText` column). If search still misses variants, extend `normalizeArabic` and re-run the
  backfill. Consider a `pg_trgm` index if listing volume grows (currently tiny, no index needed).
