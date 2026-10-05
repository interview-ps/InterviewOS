# system-design-mode

Bundled Interview OS plugin that provides the **`system_design` interview
mode** — open-ended design of a larger system with concrete scale numbers:
requirements → estimation → design → trade-offs.

## What it declares

- **Capabilities** `interview_mode` + `ui` (the dimension-coverage sidebar).
- **Mode** `system_design`:
  - scope: `system-design` and `distributed-systems` taxonomy subtrees
    (`scope.include`)
  - rubric + walk order: `requirements`, `constraints`, `scaleAssumptions`,
    `architecture`, `dataModel`, `apis`, `storage`, `caching`, `reliability`,
    `scalability`, `tradeOffs`
  - initial state: every dimension `{ status: "not_covered", notes: "" }`,
    `problem: null`, `focusDimension: null`
  - `mode.reduce` rank-merges evaluator `designUpdates` into dimension
    coverage (never downgrades); the declarative `reduce` fallback copies
    `question.extra.problem` / `focusDimension` if the hook fails
  - `mode.prepareTurn` returns the next uncovered dimension (plus the skill
    a probe should target) — the host feeds it to the interviewer as
    `focusDimension`; `null` on follow-up turns
  - follow-up policy `never` — the round walks dimensions directly
- **Prompts** `prompts/interviewer.md` + `prompts/evaluator.md`; the evaluator
  prompt asks for `designUpdates` per dimension.
- **Hooks** `mode.reduce`, `mode.prepareTurn`, `mode.mock` (deterministic
  MockRuntime output), `ui.render` (the `design-dimensions` panel for the
  `interview.sidebar` slot).
- **Permission** `answers.read` — auto-granted for bundled plugins.

## Disabling

Disable the plugin in Settings → Plugins. New sessions, loops and company-round
creation then reject `system_design` with a typed error — but past sessions
still render in history and the session view.

## Tests

```
pnpm vitest run plugins/system-design-mode
```
