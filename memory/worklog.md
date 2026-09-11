# Work log

Chronological log of significant changes (newest first). Keep entries short; link commits/files.

## 2026-09-11 — Main consolidation baseline
- Imported the audited trusted-proxy patch and the 24-commit notification foundation onto `main`.
- Added the corrected producer contract test. The backend foundation is present, while five
  producer/transaction assertions remain intentionally failing; frontend work is not implemented.
- Added the approved consolidation design/plan and accuracy-reviewed project references.

## 2026-06-14 — Arabic-aware listing search
- Search was a literal substring match; Arabic queries missed equivalent letter forms
  (e.g. "ايفون" didn't match "آيفون").
- Added `src/shared/utils/arabic.ts` (`normalizeArabic` / `buildListingSearchText`), a `searchText`
  column on `Listing` (migration `20260614180000_add_listing_search_text`), normalized matching in
  `listings.repository.ts`, recompute on edit in `listings.service.ts`, and a best-effort backfill
  (`scripts/backfill-search-text.ts`, wired into deploy). Commit `c7752f7`. 91 tests pass.

## 2026-06-14 — Production bug fixes (client-reported: login + listing errors)
- **Login "unexpected error"**: root cause was CORS — `CORS_ORIGIN` had a trailing slash, so the
  backend rejected the site's own `Origin` on every browser POST → 500. Fixed by normalizing
  trailing slashes in `env.ts` (commit `20662b8`). Verified by logging in live.
- **Listing detail "Internal server error"**: missing `soldAt`/`archivedAt` columns (schema drift);
  fixed by migration `20260614085133` (already deployed before this session). Verified live.
- **Hardening** (commit `1fd77f5`): login no longer fails when the post-auth profile sync hiccups;
  `recordView` no longer 500s when non-critical view-tracking/analytics writes fail.

## 2026-06-14 — Full functionality QA (browser)
- Verified live: home, search, favorites, create-listing (4-step wizard + image upload → pending),
  my-listings, listing detail, messaging (conversation + send), account settings, register form
  validation, static pages. All core flows work. Test data left in place (1 pending listing, 1
  message to seed user Ahmed Al-Salem).

> Note: deploys are pushed by the `devsooqna-arch` GitHub account; the local machine's git credential
> may be a different account that lacks push access. If `git push` 403s, push as `devsooqna-arch`.
