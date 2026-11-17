# Branch cleanup / exact-HEAD archive index

This `delete` branch is an index, not a backup of the independent source Git histories. No original branch has been deleted. Do not delete originals without owner approval and independent refs verification.

## Additional branch preservation, verified exact Git HEAD
- `codex/fix-canonical-api-origin` → `archive/cleanup-20261117/canonical-api-origin` at `5fd733763d2fdc1f3eca62f24a35210af704e575` (verified identical)
- `codex/fix-legacy-upload-origin` → `archive/cleanup-20261117/legacy-upload-origin` at `9b45148d26d705baa762e90ad7e1d436e34cc7d9` (verified identical)
- `codex/notification-system` → `archive/cleanup-20261117/notification-system` at `05668eb464ae6f0e6b0c737c743c909b594196c1` (verified identical)

## Full original-branch classification checkpoint
Already contained in current `dev` with **0 exclusive commits** (no re-merge needed): `Dev`, `Master`, `codex/admin-product-analytics-enhancements`, `codex/notification-integration`, `preserve/softshop-wip-2026-09-11`, `softshop`.

Divergent unique work remains preserved independently and is NOT automatically merged: `codex/fix-canonical-api-origin`, `codex/fix-legacy-upload-origin`, `codex/notification-system`. Original source branches remain present until owner-approved deletion.
