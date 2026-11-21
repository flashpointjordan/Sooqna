# GitHub Governance — Sooqna

## Branch roles
- `main`: production deployment boundary after successful CI.
- `dev`: integration branch.
- feature/fix/work branches: pull-request work targeting dev.

## Required release evidence
- CI success on exact candidate;
- backend/frontend contract and Firebase credential handling preserved;
- no production secrets in source;
- explicit release approval;
- post-deploy health/readback.

No force push or branch deletion on production refs.
