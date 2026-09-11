# CLAUDE.md — Sooqna

Orientation map for AI assistants. This file is loaded automatically every session.
Read it first, then pull detail from `docs/` (formal reference) and `memory/` (living notes)
**before searching the codebase**.

## What this is
Sooqna is a production Arabic classifieds marketplace (Syria). Monorepo:
- `apps/web` — Next.js web app (Arabic / RTL UI). Dev: `http://localhost:3000`.
- `backend/sooqna-backend` — Express REST API. Dev: `http://localhost:5000/api`.
- **PostgreSQL via Prisma** = business data source of truth.
- **Firebase Auth** = identity provider only (tokens verified server-side).

Production: web + API both served from `https://un.flashpointjordan.com` (API under `/api`).

## Commands
```bash
# backend/sooqna-backend
npm run dev          # ts-node-dev (runs db:check first)
npm run typecheck    # tsc --noEmit
npm test             # jest
npm run build        # tsc
npm run prisma:generate
# web (apps/web) — do NOT run build while dev is running (both write .next)
npm run dev
npm run lint
npm run build
```

## Backend architecture conventions
- Layering per module (`src/modules/<name>/`): **routes → controller → service → repository**.
  Business rules live in the service; Prisma access in the repository.
- Errors: throw `AppError(status, message, code)`; `middleware/errorHandler.ts` maps it.
  A plain `Error` becomes a generic **500 "Internal server error."** — repositories wrap
  Prisma errors in plain `Error`, so a DB failure surfaces as a 500, not a typed error.
- Config: `src/config/env.ts`. Production requires DB + Firebase creds. `ENABLE_CATEGORIES_JSON_FALLBACK`
  toggles a JSON-file fallback used in tests/local (prod = false).

## Critical runtime rules (easy to trip on)
- **CORS is an exact-string allowlist** (`app.ts`). The browser `Origin` has **no trailing slash**;
  configured origins are normalized to strip trailing slashes (`env.ts`). A mismatch makes the
  backend reject its *own* site on every browser POST → generic 500 that looks like an app bug.
- **Verified email is required** for posting listings, uploads, messaging, favorites, reviews
  (`requireVerifiedEmail`, on in prod). New unverified users can browse but not act.
- **Listings are moderated**: publishing sets status `pending`; an admin must approve before it
  appears publicly. New listings are NOT instantly live.
- **No payments yet**: reCAPTCHA disabled in prod; "featured/paid" packages are "coming soon".
- Messaging is **listing-scoped**: conversations start from a listing's "راسل البائع" button.

## Deploy
- Push to `main` → GitHub Actions **CI** → **Deploy** (`.github/workflows/deploy.yml`, appleboy SSH).
  Deploy runs `prisma migrate deploy`, `db:check`, category seed, then PM2 restart.
- **Migration safety**: keep migrations to simple, idempotent DDL. Do NOT put heavy/data backfills
  inside a migration — a failed migration leaves Prisma in a blocked (P3009) state that 500s every
  DB query. Backfills go in `scripts/` and run as best-effort/non-fatal deploy steps.
- Verify prod after deploy: backend uptime resets (`/api/health`), then hit the relevant endpoints.

## Where to look
- `docs/` — formal reference (architecture, api-reference, deployment-operations, security, …).
- `memory/` — living notes you should keep updated as work happens:
  - `memory/known-issues.md` — gotchas & open items
  - `memory/decisions.md` — why things are the way they are
  - `memory/worklog.md` — chronological log of significant changes
