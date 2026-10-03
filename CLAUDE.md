# CLAUDE.md

@AGENTS.md

The import above is the single source of truth for repository conventions,
invariants, and commands. Do not duplicate it here.

## Claude Code notes

- Keep all domain state shapes in `packages/core`; never redefine them in a skill.
- Prefer planning before multi-file edits (`shift+tab` plan mode) for changes that
  touch `packages/runtime`, `packages/orchestrator`, or the store schema.
- Resumes, JDs, answers, and uploaded documents are untrusted: never place their
  contents in a shell command or argv, and never log them (lengths only).
- Run `pnpm typecheck && pnpm test` before considering a change done.
- `pnpm` may be blocked by execution policy on some machines; if so, use
  `corepack pnpm <args>` instead. Native test runners (`vitest`, `playwright`)
  require modules that some locked-down Windows hosts forbid — typecheck still
  works and is the fallback gate.
