# memory/

Living project memory for AI assistants (and humans). The goal: capture the **"why"**,
the **gotchas**, and the **history of significant work** so an assistant can get productive
**without re-reading the whole codebase**.

This complements two other things:
- `docs/` — formal, stable reference (architecture, API, deployment). Changes rarely.
- `../CLAUDE.md` — the auto-loaded entry point that links here. Keep it short.

This `memory/` folder is **not auto-loaded** by Claude Code. `../CLAUDE.md` points to it, so an
assistant knows to read these files when relevant. Keep each file high-signal.

## Files
- `known-issues.md` — current gotchas, traps, and open items. Check before debugging.
- `decisions.md` — design/product decisions and their rationale.
- `worklog.md` — chronological log of significant changes (newest first).

## How to maintain (do this as work happens)
- Fixed a non-obvious bug or learned a trap? → add/update `known-issues.md`.
- Made a design/product call worth remembering? → `decisions.md`.
- Shipped something significant? → prepend an entry to `worklog.md`.
- Keep entries short and factual. Use absolute dates. Delete entries that become wrong —
  stale memory is worse than no memory.
