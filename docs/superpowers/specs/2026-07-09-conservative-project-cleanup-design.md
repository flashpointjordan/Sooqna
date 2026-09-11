# Conservative Project Cleanup Design

## Goal

Clean the repository without removing required source code, runtime assets, migrations, tests, or environment examples. The cleanup focuses on tracked files that are stale, broken, or planning-only, while leaving ignored local build artifacts such as `node_modules` and `.next` alone.

## Scope

- Resolve the unmerged `backend/sooqna-backend/scripts/backfill-search-text.ts` path conservatively.
- Remove tracked planning artifacts that are not current project documentation.
- Add a current end-to-end project documentation entry point.
- Update top-level documentation indexes so future contributors know where to start.
- Do not remove lockfiles, Prisma migrations, upload `.gitkeep` files, public images, tests, or `.env.example` files.

## Decisions

- The search-text backfill script should be removed. The current Prisma schema has no `Listing.searchText` field, and the referenced `src/shared/utils/arabic` helper is absent, so keeping the script would leave a broken tracked file.
- The old `docs/superpowers/plans/2026-05-28-admin-product-analytics-enhancements.md` file should be removed from the public docs tree. It is an implementation plan artifact, not maintained product documentation.
- A new `docs/project-documentation.md` should become the A-to-Z overview, with `README.md` and `docs/README.md` pointing to it.

## Verification

- Check that Git has no unmerged paths after cleanup.
- Run backend typecheck and tests.
- Run web lint.
- If a full web build is safe in the current environment, run it after lint; otherwise report why it was skipped.
