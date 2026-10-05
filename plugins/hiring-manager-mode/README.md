# hiring-manager-mode

Bundled Interview OS plugin that provides the **`hiring_manager` interview
mode** — the conversation a hiring manager would have: scope, impact,
priorities and leadership style.

## What it declares

- **Capability** `interview_mode`.
- **Mode** `hiring_manager`:
  - scope: `hiring-manager`, `behavioral.leadership` and `communication`
    taxonomy subtrees (`scope.include`)
  - rubric: `roleFit`, `scopeImpact`, `prioritization`, `leadership`,
    `collaboration`, `motivation`
  - initial state `{ themesCovered: [] }` — the `mode.reduce` hook records
    each asked question's topic
  - context flags `companyThemes` + `storyTitles`
- **Prompts** `prompts/interviewer.md` + `prompts/evaluator.md`.
- **Hooks** `mode.reduce` and `mode.mock` (deterministic MockRuntime output
  for `interviewer.hiring_manager` / `answer-evaluator.hiring_manager`).
- **Permission** `answers.read` — auto-granted for bundled plugins.

## Disabling

Disable the plugin in Settings → Plugins. New sessions, loops and company-round
creation then reject `hiring_manager` with a typed error — but past sessions
still render in history and the session view.

## Tests

```
pnpm vitest run plugins/hiring-manager-mode
```
