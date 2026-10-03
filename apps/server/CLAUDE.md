# CLAUDE.md — @interview-os/server

@AGENTS.md

The import above is the layer source of truth for conventions, invariants, and layout in
`apps/server`. The repository-wide rules in the root `@AGENTS.md` also apply. Do not
duplicate either here.

## Claude Code notes
- Plan before multi-file edits touching `src/orchestrator/`, `src/skills/host/`,
  `src/http/`, or `store/schema.ts`; these are the highest-blast-radius areas.
- Keep the `InterviewOrchestrator` public surface stable — tests and routes depend on it.
  Prefer adding a service method behind it over changing an existing signature.
- Preserve the service DAG (`preparation → readiness`, `target → workspace → readiness`,
  `loop → interview`, `interview ← loopContextFor` callback). A new cycle means the design
  is wrong, not that the import needs fixing.
- Never call `skill.execute` from routes or orchestrator; go through `SkillHost`.
- Route handlers stay thin: validate → orchestrator call → serialize. No SQL, no skills.
- Run `pnpm --filter @interview-os/server typecheck` while iterating, then
  `pnpm typecheck && pnpm test` from the root before calling it done.
- `pnpm` may be blocked by execution policy; if so use `corepack pnpm <args>`.
