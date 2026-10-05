# behavioral-mode

Bundled Interview OS plugin that provides the **`behavioral` interview mode** —
STAR stories from the candidate's experience: a specific situation, their
actions, measurable results.

## What it declares

- **Capability** `interview_mode`.
- **Mode** `behavioral`:
  - scope: the `behavioral` and `communication` taxonomy subtrees
    (`scope.include`)
  - rubric: `situationClarity`, `ownership`, `actions`, `decisionMaking`,
    `impact`, `results`, `reflection`, `communication`
  - initial state `{ storyIdsUsed: [], competenciesCovered: [] }` — the
    `mode.reduce` hook tracks which story titles have been used and which
    competencies the round has covered
  - context flags `companyThemes` + `storyTitles` — the host feeds the
    company profile's behavioral themes and the candidate's story titles
    into the interviewer input (never into the plugin process)
- **Prompts** `prompts/interviewer.md` + `prompts/evaluator.md`, read by the
  server loader at plugin load and embedded by the host's mode prompt wrapper.
- **Hooks** `mode.reduce` and `mode.mock` (deterministic MockRuntime output
  for `interviewer.behavioral` / `answer-evaluator.behavioral`).
- **Permission** `answers.read` — auto-granted for bundled plugins.

## Disabling

Disable the plugin in Settings → Plugins. New sessions, loops and company-round
creation then reject `behavioral` with a typed error — but past sessions still
render in history and the session view.

## Tests

```
pnpm vitest run plugins/behavioral-mode
```
