# Conservative Project Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean the Sooqna repository conservatively and add current A-to-Z documentation.

**Architecture:** Keep source directories intact. Remove only tracked artifacts proven stale or broken, resolve the Git conflict by deleting the invalid backfill script, and add a maintained documentation entry point.

**Tech Stack:** Next.js 15, React 19, Express 4, Prisma 7, PostgreSQL, Firebase Auth, Jest, Playwright, GitHub Actions.

---

### Task 1: Resolve Broken Conflict Artifact

**Files:**
- Delete: `backend/sooqna-backend/scripts/backfill-search-text.ts`
- Modify: `CLAUDE.md`

- [x] Delete the conflicted search-text backfill script because the schema does not define `Listing.searchText` and the imported Arabic helper is absent.
- [x] Update assistant/deploy orientation text so it no longer says deploy runs a search backfill.
- [x] Run `git status --short` and confirm the unmerged path is gone.

### Task 2: Remove Stale Planning Artifact

**Files:**
- Delete: `docs/superpowers/plans/2026-05-28-admin-product-analytics-enhancements.md`

- [x] Remove the old admin analytics implementation plan from the docs tree.
- [x] Keep current design and implementation notes for this cleanup under `docs/superpowers/`.

### Task 3: Add Current Project Documentation

**Files:**
- Create: `docs/project-documentation.md`
- Modify: `README.md`
- Modify: `docs/README.md`

- [x] Add a maintained A-to-Z documentation file covering product purpose, repository layout, local setup, architecture, backend, frontend, data, auth, uploads, admin, deployment, testing, security, and troubleshooting.
- [x] Update the root README to point contributors at the new documentation entry point.
- [x] Update the docs index reading order and maintenance rules.

### Task 4: Verify

**Commands:**
- `git status --short`
- `cd backend/sooqna-backend; npm run typecheck`
- `cd backend/sooqna-backend; npm test -- --runInBand`
- `cd apps/web; npm run lint`

- [x] Confirm there are no unmerged paths.
- [x] Record any failed verification with the exact failing command and reason.
