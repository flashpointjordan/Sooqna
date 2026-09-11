# Sooqna

Sooqna is a production-oriented Arabic classifieds marketplace monorepo for Syria.

## Active Product

- `apps/web` - Next.js 15 web app with Arabic/RTL UI.
- `backend/sooqna-backend` - Express REST API.
- PostgreSQL through Prisma - business data source of truth.
- Firebase Auth - identity provider only; backend verifies Firebase ID tokens.

Generated reports, local screenshots, logs, ZIP exports, build outputs, and temporary helper tools should stay out of Git.

## Quick Start

```bash
cd backend/sooqna-backend
npm install
npm run prisma:generate
npm run db:check
npm run dev
```

Backend API: `http://localhost:5000/api`

```bash
cd apps/web
npm install
npm run dev
```

Web app: `http://localhost:3000`

Do not run `npm run build` while `npm run dev` is running for the web app. Both write to `.next`, and the build script includes a guard for this.

## Main Checks

```bash
cd backend/sooqna-backend
npm run typecheck
npm test
npm run build
```

```bash
cd apps/web
npm run lint
npm run build
```

## Documentation

Start with `docs/project-documentation.md` for the A-to-Z project reference, then use `docs/README.md` for the full documentation map.
