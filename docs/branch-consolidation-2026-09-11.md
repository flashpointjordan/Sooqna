# Branch Consolidation Inventory — 2026-09-11

This inventory records the preservation state before any integration, branch deletion, worktree removal, or remote push. `git fetch --prune origin` completed successfully before the audit.

## Starting refs

| Ref | Recorded commit | Upstream | Subject |
| --- | --- | --- | --- |
| `main` | `f1726c65afe07f7f019b3c79ae13cc98ab4c64da` | `origin/main` | `fix: reduce messaging polling traffic` |
| `Dev` | `397ac684adaa850a89cbc783b41555955c0452e1` | `origin/Dev` | `fix(deploy): disable reCAPTCHA in production env to unblock deploy` |
| `Master` | `397ac684adaa850a89cbc783b41555955c0452e1` | `origin/Master` | `fix(deploy): disable reCAPTCHA in production env to unblock deploy` |
| `softshop` | `02eb74051f287c6214828f624ac6a8b9800592a1` | — | `docs: plan main consolidation and notifications` |
| `codex/notification-system` | `6febfba7b2bb8ffc3f9676ff3f80e8a31a6a8a66` | — | `fix: fence notification streams during shutdown` |
| `codex/rate-limit-proxy-fix` | `afa95b47dcae67170ea03871a8d71c3d40bd1aa8` | — | `fix: reduce messaging polling traffic` |
| `origin/main` | `f1726c65afe07f7f019b3c79ae13cc98ab4c64da` | — | `fix: reduce messaging polling traffic` |
| `origin/Dev` | `397ac684adaa850a89cbc783b41555955c0452e1` | — | `fix(deploy): disable reCAPTCHA in production env to unblock deploy` |
| `origin/Master` | `397ac684adaa850a89cbc783b41555955c0452e1` | — | `fix(deploy): disable reCAPTCHA in production env to unblock deploy` |
| `origin/softshop` | `ec45481f86f91bd7da18fcfa28fa469fdc579e98` | — | `ci: deploy softshop branch` |
| `origin/codex/admin-product-analytics-enhancements` | `e0707315c7cc9b0154c90d644abf5f99c6a18e75` | — | `Document analytics and marketplace enhancements` |

`origin/HEAD` resolved to the same commit as `origin/main`.

## Starting divergence from `main`

Counts are `main-only | branch-only`, captured before preservation commits.

| Comparison | Counts |
| --- | ---: |
| `main...Dev` | `14 | 0` |
| `main...Master` | `14 | 0` |
| `main...softshop` | `14 | 6` |
| `main...codex/notification-system` | `0 | 24` |
| `main...codex/rate-limit-proxy-fix` | `14 | 9` |

Patch-equivalence evidence from `git cherry -v main <branch>`:

- `Dev`, `Master`, and `origin/codex/admin-product-analytics-enhancements` had no unique patches.
- `softshop` had three unique patches: the rejected softshop deployment workflow plus the approved 2026-09-11 design and plan. Its three rate-limit documentation/ignore patches were already patch-equivalent to `main`.
- `origin/softshop` contained only the rejected softshop deployment patch.
- `codex/notification-system` had 24 unique commits, from `be5581280c0d47e7f9e3a96c8b13c4dffc414de9` through `6febfba7b2bb8ffc3f9676ff3f80e8a31a6a8a66`.
- `codex/rate-limit-proxy-fix` had two non-equivalent patches: rejected softshop deployment commit `eab132735e38114f6739003a98de82dedbbb2323` and accepted production proxy commit `4c75e6f7895b6f7870b17b80143537ee04471e65`. Its remaining rate-limit patches were already patch-equivalent to `main`.

## Worktrees and preservation state

The starting worktree inventory was:

| Worktree | Starting branch and commit | Starting status |
| --- | --- | --- |
| Repository root | `softshop` at `02eb74051f287c6214828f624ac6a8b9800592a1` | Documentation/memory changes listed below |
| `.worktrees/codex-rate-limit-proxy-fix` | `codex/rate-limit-proxy-fix` at `afa95b47dcae67170ea03871a8d71c3d40bd1aa8` | Clean |
| `.worktrees/main-rate-limit-integration` | `codex/notification-system` at `6febfba7b2bb8ffc3f9676ff3f80e8a31a6a8a66` | Only untracked `notifications.producers.test.ts` |

The primary dirty documentation/memory state was moved without loss to `preserve/softshop-wip-2026-09-11` and committed as `b1467b3a0628cad33f0385719a3efa179dd8885d` (`docs: preserve project consolidation work`). The commit contains only:

- `CLAUDE.md`
- `README.md`
- `docs/README.md`
- `docs/project-documentation.md`
- deletion of `docs/superpowers/plans/2026-05-28-admin-product-analytics-enhancements.md`
- `docs/superpowers/plans/2026-07-09-conservative-project-cleanup.md`
- `docs/superpowers/specs/2026-07-09-conservative-project-cleanup-design.md`
- `memory/README.md`
- `memory/decisions.md`
- `memory/known-issues.md`
- `memory/worklog.md`

No application source, secrets, screenshots, dependencies, or generated outputs were included. The 2026-09-11 consolidation design and plan were already committed in `c5f9fd83c7908d1811f53ae4fff2d66175ee7622` and `02eb74051f287c6214828f624ac6a8b9800592a1`; they were not duplicated in the preservation commit.

The notification worktree's sole untracked file, `backend/sooqna-backend/src/modules/notifications/notifications.producers.test.ts`, was reviewed. Its credential-like strings are fake leak-detection fixtures. It was committed alone as `76617431d0d8194f122dc452d021ba061dea02c8` (`test: expose missing notification producers`).

After preservation, the root worktree was clean on `preserve/softshop-wip-2026-09-11` at `b1467b3a0628cad33f0385719a3efa179dd8885d`; the rate-limit worktree was clean at `afa95b47dcae67170ea03871a8d71c3d40bd1aa8`; and the notification worktree was clean at `76617431d0d8194f122dc452d021ba061dea02c8`.

## Local archive tags

These are annotated local tags only; none were pushed.

| Tag | Peeled target |
| --- | --- |
| `archive/2026-09-11/softshop` | `02eb74051f287c6214828f624ac6a8b9800592a1` |
| `archive/2026-09-11/origin-softshop` | `ec45481f86f91bd7da18fcfa28fa469fdc579e98` |
| `archive/2026-09-11/rate-limit-proxy-fix` | `afa95b47dcae67170ea03871a8d71c3d40bd1aa8` |
| `archive/2026-09-11/notification-system` | `6febfba7b2bb8ffc3f9676ff3f80e8a31a6a8a66` |
| `archive/2026-09-11/admin-product-analytics` | `e0707315c7cc9b0154c90d644abf5f99c6a18e75` |

The notification archive tag intentionally records the audited pre-preservation branch head; the preserved producer-test commit is separately identified above.

## Notification test baseline

Command run from `.worktrees/main-rate-limit-integration/backend/sooqna-backend`:

```text
npm test -- --runInBand src/modules/notifications
```

Exact result: exit code `1`; `10` suites total (`9` passed, `1` failed); `88` tests total (`83` passed, `5` failed); `0` snapshots. All failures were in `notifications.producers.test.ts`: missing message fan-out, missing atomic message rejection when outbox enqueue fails, missing favorite producer, missing review producer, and missing review enqueue-failure logging. The producer test pins `2026-08-24T15:42:00.000Z` and asserts the exact favorite aggregation key `listing-favorite:listing-1:2026-08-24T15`; the existing engagement write is mocked so it no longer masks the intended producer failure. No application failure was fixed during preservation.

## Acceptance classification

- **ACCEPT commit `4c75e6f`** (trusted production proxy).
- **ACCEPT notification-system series and preserved producer test**.
- **ACCEPT AFTER ACCURACY REVIEW docs/memory edits**.
- **REJECT `deploy-softshop.yml`** because production deploys `main`.
- **REJECT rate-limit patches already patch-equivalent to `main`**.

Accuracy review is required because the preserved documentation reflects an earlier repository state. In particular, its search/backfill notes conflict with the preserved cleanup decision to remove the invalid backfill script, so those statements must be checked against the integration tree before acceptance.

No branch was deleted, no worktree was removed, and no remote ref or tag was pushed during this preservation task.

## Main integration and documentation accuracy review

Integration started from `main`/`origin/main` at `f1726c65afe07f7f019b3c79ae13cc98ab4c64da` in `.worktrees/main-notifications`.

- The audited proxy commit `4c75e6f7895b6f7870b17b80143537ee04471e65` was applied first. Its one `env.ts` conflict was resolved by retaining current-main CORS normalization and `ADMIN_EMAILS` handling alongside the audited proxy parser and production validation. The result was empty because current `main` already contained the audited file changes; it was recorded explicitly as `eccab7f8ab38ee0a97b73ecee3ab437bf7f52ccb`. `TRUST_PROXY=1` remains in `.github/workflows/deploy.yml`, the proxy tests are present, and `.github/workflows/deploy-softshop.yml` is absent.
- The exact 24-commit notification range `be558128^..6febfba` applied in order without conflicts.
- Corrected producer test `76617431d0d8194f122dc452d021ba061dea02c8` applied after the foundation as `53f1196`.
- The approved September 11 design and plan were restored by exact path and committed alone as `a68f624` (`docs: add main consolidation plan`).

The remaining paths from preservation commit `b1467b3` were reviewed against the integrated tree:

| Path | Decision | Accuracy review |
| --- | --- | --- |
| `CLAUDE.md` | ACCEPT | Architecture, runtime rules, and main-only deployment guidance match the integrated tree. |
| `README.md` | ACCEPT | Commands and project entry points remain current. |
| `docs/README.md` | ACCEPT | The documentation map and maintenance rules remain useful. |
| `docs/project-documentation.md` | CORRECT | Imported, dated 2026-09-11, and updated for notification models/routes/worker/SSE, incomplete producers/frontend, the actual search backfill deploy step, and notification privacy. |
| `docs/superpowers/plans/2026-05-28-admin-product-analytics-enhancements.md` | ACCEPT DELETION | The old implementation plan is stale and is removed from the maintained documentation tree. |
| `docs/superpowers/plans/2026-07-09-conservative-project-cleanup.md` | REJECT | It incorrectly says the current schema lacks `Listing.searchText` and directs deletion of a valid backfill script. |
| `docs/superpowers/specs/2026-07-09-conservative-project-cleanup-design.md` | REJECT | Its search/backfill premises contradict current `main`; it was not imported. |
| `memory/README.md` | ACCEPT | The memory purpose and maintenance guidance are accurate. |
| `memory/decisions.md` | ACCEPT | Identity, moderation, CORS, and stored Arabic-search decisions match the code. |
| `memory/known-issues.md` | CORRECT | Existing facts were retained and the five intentional producer gaps plus absent frontend were recorded. |
| `memory/worklog.md` | CORRECT | Historical entries were retained and the 2026-09-11 integration baseline was added. |

Current-main evidence for rejecting the cleanup plan/spec: `Listing.searchText` exists in `prisma/schema.prisma`; `src/shared/utils/arabic.ts` and `scripts/backfill-search-text.ts` exist; `package.json` defines `backfill:search`; and `.github/workflows/deploy.yml` runs it as a best-effort, non-fatal post-migration step.
