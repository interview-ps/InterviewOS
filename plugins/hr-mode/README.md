# hr-mode

Bundled Interview OS plugin that provides the **`hr` interview mode** —
motivation, career goals, culture fit and work style; friendly but probing.

## What it declares

- **Capability** `interview_mode`.
- **Mode** `hr`:
  - scope: the `hr` taxonomy subtree (`scope.include`)
  - rubric: `motivation`, `careerGoals`, `cultureFit`, `workStyle`,
    `communication`
  - initial state `{ themesCovered: [] }` — the `mode.reduce` hook records
    each asked question's topic
  - context flags `companyThemes` + `storyTitles`
- **Prompts** `prompts/interviewer.md` + `prompts/evaluator.md`.
- **Hooks** `mode.reduce` and `mode.mock` (deterministic MockRuntime output
  for `interviewer.hr` / `answer-evaluator.hr`).
- **Permission** `answers.read` — auto-granted for bundled plugins.

## Disabling

Disable the plugin in Settings → Plugins. New sessions, loops and company-round
creation then reject `hr` with a typed error — but past sessions still render
in history and the session view.

## Tests

```
pnpm vitest run plugins/hr-mode
```
