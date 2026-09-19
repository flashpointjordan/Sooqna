# Sooqna Project Documentation

Last updated: 2026-07-09

## 1. Overview

Sooqna is an Arabic classifieds marketplace monorepo. The public site lets users browse listings, register or log in, create listings, upload listing images, favorite items, message sellers, review sellers, and contact the team. Admin users can moderate listings, reports, and platform activity.

Production is served from `https://un.flashpointjordan.com`, with the web app and API on the same host. API routes live under `/api`.

## 2. Repository Layout

```text
Sooqna/
  apps/web/                 Next.js web application
  backend/sooqna-backend/   Express API, Prisma schema, backend tests
  docs/                     Maintained project documentation
  memory/                   Living assistant notes and project memory
  .github/workflows/        CI and production deployment workflows
```

Important tracked files:

- `README.md` - short project entry point.
- `CLAUDE.md` - assistant orientation and operational gotchas.
- `.gitignore` - excludes dependency folders, build output, local env files, uploads, logs, and exports.
- `apps/web/package-lock.json` and `backend/sooqna-backend/package-lock.json` - lock dependency versions for reproducible installs.

## 3. Local Setup

Backend:

```bash
cd backend/sooqna-backend
npm install
npm run prisma:generate
npm run db:check
npm run dev
```

Web:

```bash
cd apps/web
npm install
npm run dev
```

Default local URLs:

- Web: `http://localhost:3000`
- API: `http://localhost:5000/api`
- Uploads: `http://localhost:5000/uploads`

Do not run the web dev server and web production build at the same time because both write to `.next`.

## 4. Environment Configuration

Use `.env.example` files as templates:

- `apps/web/.env.example`
- `backend/sooqna-backend/.env.example`

Backend production requires:

- `DATABASE_URL`
- Firebase Admin credentials through service account path, client email/private key, or application default credentials
- `CORS_ORIGIN`
- `BACKEND_PUBLIC_ORIGIN` or `UPLOADS_PUBLIC_BASE_URL`

Web production requires public Firebase config and public API/upload origins through `NEXT_PUBLIC_*` variables.

Never commit `.env`, `.env.local`, private keys, service-account JSON, database URLs, or production tokens.

## 5. Backend Architecture

Backend source lives in `backend/sooqna-backend/src`.

The standard module pattern is:

```text
routes -> controller -> service -> repository
```

Use this split as follows:

- Routes define URL structure and middleware.
- Controllers translate HTTP input/output.
- Services hold business rules.
- Repositories isolate Prisma/database access.
- Shared validation lives under `src/shared/validation`.
- Shared API contracts live under `src/shared/contracts`.
- Cross-cutting middleware lives under `src/middleware`.

The API root is assembled in `src/routes/index.ts`. Main modules include auth, users, listings, uploads, favorites, messages, categories, cities, engagement, reports, reviews, audit, admin, contact, market, and saved searches.

## 6. Data Model

PostgreSQL is the source of truth. Prisma files live in:

- `backend/sooqna-backend/prisma/schema.prisma`
- `backend/sooqna-backend/prisma/migrations/`

Core models:

- `User` - local profile linked to Firebase UID.
- `Listing` - marketplace item with moderation status, category, location, owner snapshot, and counters.
- `ListingImage` and `Upload` - stored image metadata.
- `Favorite` - user/listing save relationship.
- `Conversation`, `ConversationParticipant`, `Message` - listing-scoped messaging.
- `Category` and `City` - marketplace taxonomy and locations.
- `Report`, `AuditLog`, `Review`, `SavedSearch`, `EngagementEvent` - moderation, trust, personalization, and analytics.

Firebase Auth is not the business database. It provides identity tokens that the backend verifies before reading or mutating protected resources.

## 7. Authentication And Authorization

The web app signs users in with Firebase. Authenticated API calls attach a Firebase ID token in the `Authorization: Bearer <token>` header.

Backend auth middleware:

- `verifyFirebaseToken` verifies Firebase tokens.
- `requireCurrentUser` requires a matching local user context.
- `requireActiveUser` blocks inactive accounts.
- `requireVerifiedEmail` protects actions that require verified email.
- `checkRole` restricts admin routes by role.

In production, verified email is required for posting listings, uploads, messaging, favorites, and reviews unless explicitly disabled by environment.

## 8. Frontend Architecture

The web app lives in `apps/web`.

Important areas:

- `src/app/` - Next.js App Router pages and layouts.
- `src/components/` - UI and feature components.
- `src/services/` - API clients and payload builders.
- `src/lib/` - formatting, SEO, Firebase, listing helpers, and UI metadata.
- `src/hooks/` - reusable React hooks.
- `src/types/` - frontend TypeScript types.
- `tests/` - unit-style tests and Playwright smoke tests.

The UI is Arabic/RTL-oriented. Keep user-facing Arabic strings clear, direct, and consistent with existing pages.

## 9. Key User Flows

- Browse listings from the homepage, category pages, listing pages, and search/filter views.
- Register or log in through Firebase-backed forms.
- Create a listing, upload images, then wait for admin approval.
- Manage own listings from the account area.
- Favorite listings.
- Start listing-scoped conversations from listing details.
- Review sellers after relevant listing interactions.
- Submit contact requests through the contact form.

Listings are moderated: newly published listings are pending until approved by an admin.

## 10. Admin And Moderation

Admin features include:

- Dashboard overview.
- Listing moderation.
- Report moderation.
- User and activity visibility.
- Audit log visibility.

Admin-only routes require Firebase auth, a local active user, and an admin role.

## 11. Uploads

Backend uploads are stored under `backend/sooqna-backend/uploads/` locally. Git tracks only `.gitkeep` placeholders for the listing and profile upload folders.

Upload rules:

- Keep real uploaded files out of Git.
- Validate image MIME type, extension, and file signature.
- Serve browser-facing upload URLs from `UPLOADS_PUBLIC_BASE_URL` or `BACKEND_PUBLIC_ORIGIN`.
- Use the orphan-upload cleanup script when needed:

```bash
cd backend/sooqna-backend
npm run uploads:cleanup-orphans
```

## 12. CI And Deployment

GitHub Actions:

- `.github/workflows/ci.yml` runs backend checks and web checks on `main` pushes and pull requests.
- `.github/workflows/deploy.yml` deploys after successful CI on `main`.

Backend CI runs install, Prisma generate, production dependency audit, typecheck, tests, and build.

Web CI runs install, production dependency audit, redirect validation, lint, and build with CI placeholder public environment values.

Production deploy over SSH:

1. Cleans untracked server files while preserving uploads and web `.env.local`.
2. Checks out `origin/main`.
3. Installs backend dependencies.
4. Generates Prisma client.
5. Builds backend TypeScript.
6. Normalizes and exports `DATABASE_URL`.
7. Writes backend `.env`.
8. Runs `prisma migrate deploy`.
9. Runs `db:check`.
10. Seeds categories from JSON.
11. Restarts backend with PM2.
12. Writes web `.env.local`.
13. Installs web dependencies.
14. Builds web.
15. Restarts web with PM2.
16. Runs backend health check.

## 13. Testing And Quality Commands

Backend:

```bash
cd backend/sooqna-backend
npm run typecheck
npm test
npm run build
```

Web:

```bash
cd apps/web
npm run lint
npm run build
npm run e2e
```

Useful backend scripts:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run db:check
npm run db:migrate-json
npm run uploads:cleanup-orphans
```

Useful web scripts:

```bash
npm run validate:env
npm run validate:redirects
npm run assert:css
npm run assert:branding
```

## 14. Security Rules

- Do not commit secrets.
- Keep CORS as an exact-origin allowlist.
- Keep production Firebase Admin configuration explicit.
- Keep `RECAPTCHA_ENABLED=false` in production unless a valid reCAPTCHA secret and frontend site key are configured.
- Keep upload validation strict.
- Keep admin routes behind role checks.
- Keep rate limits and error handling enabled.
- Avoid exposing developer routes in production.

## 15. Repository Cleanliness Rules

Keep these out of Git:

- `node_modules/`
- `.next/`
- `dist/`
- logs
- ZIP exports
- generated reports
- screenshots
- local `.env` files
- real upload files
- temporary migration/backfill helpers after they are no longer valid
- old phase documents and implementation plans that are not maintained references

Keep these in Git:

- source code
- tests
- lockfiles
- Prisma schema and migrations
- `.env.example` files
- public branding/hero/placeholder assets
- upload folder `.gitkeep` placeholders
- maintained documentation

## 16. Troubleshooting

Backend cannot start:

- Check `DATABASE_URL`.
- Run `npm run prisma:generate`.
- Run `npm run db:check`.
- Confirm Firebase Admin env is configured in production.

Browser requests fail with CORS:

- Confirm `CORS_ORIGIN` exactly matches the browser origin and has no trailing slash.

New listings do not appear publicly:

- Confirm the listing is approved. Published listings enter moderation before public visibility.

Uploads show broken URLs:

- Confirm `UPLOADS_PUBLIC_BASE_URL` or `BACKEND_PUBLIC_ORIGIN`.
- Confirm files exist under the expected upload folder.

Web build fails:

- Stop `npm run dev` before running `npm run build`.
- Confirm required `NEXT_PUBLIC_*` values exist.

Deploy fails after migrations:

- Inspect GitHub Actions logs.
- Check Prisma migration status on the server.
- Keep data backfills outside migrations unless they are small, idempotent, and safe.

## 17. Maintenance Checklist

Before merging significant changes:

- Backend typecheck passes.
- Backend tests pass.
- Web lint passes.
- Web build passes when environment is available and no dev server is writing `.next`.
- Documentation reflects changed commands, env vars, deploy steps, routes, or user-facing behavior.
- `git status` has no unmerged paths and no generated files accidentally staged.
