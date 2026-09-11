# Sooqna Documentation

This folder is the maintained project documentation source. It replaces old phase notes, generated reports, screenshots, exports, and temporary planning files.

## Reading Order

1. `project-documentation.md` - A-to-Z project reference and current source of truth.
2. `architecture.md` - system boundaries and data ownership.
3. `local-development.md` - local setup and daily commands.
4. `api-reference.md` - backend modules and route map.
5. `admin-dashboard.md` - admin features, roles, and moderation.
6. `deployment-operations.md` - CI/CD, deployment, database, and runtime operations.
7. `security.md` - auth, authorization, rate limits, uploads, and secrets.
8. `product-roadmap.md` - recommended product improvements.
9. `sooqna-website-complete-documentation.md` - legacy complete website reference kept for historical detail.

## Documentation Rules

- Keep `project-documentation.md` aligned with production code when architecture, commands, env vars, deploy flow, or user-facing behavior changes.
- Do not commit generated reports, screenshots, logs, ZIP exports, local build output, or dependency folders.
- Do not include secrets, private keys, database URLs, Firebase credentials, or production tokens.
- Prefer updating the maintained reference over adding new phase documents.
