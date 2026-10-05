# technical-mode

Bundled Interview OS plugin that provides the **`technical` interview mode** —
deep technical Q&A: one question per skill, probing mechanics, edge cases and
trade-offs in the candidate's own context.

## What it declares

- **Capability** `interview_mode`.
- **Mode** `technical`:
  - scope: everything _except_ the `system-design`, `behavioral`,
    `communication`, `hr`, `coding` and `hiring-manager` subtrees
    (`scope.exclude`)
  - rubric: `correctness`, `technicalDepth`, `reasoning`, `communication`,
    `roleRelevance` (evaluator must return exactly these ids)
  - follow-up policy: `generic` (the default — follows the evaluator's
    followUpTopics)
- **Prompts** `prompts/interviewer.md` + `prompts/evaluator.md`, read by the
  server loader at plugin load and embedded by the host's mode prompt wrapper.
- **Hook** `mode.mock` — deterministic MockRuntime output for
  `interviewer.technical` / `answer-evaluator.technical`.
- **Permission** `answers.read` — auto-granted for bundled plugins; without it
  the host strips `answer`/`code` from `mode.mock` evaluator input.

## Disabling

Disable the plugin in Settings → Plugins. New sessions, loops and company-round
creation then reject `technical` with a typed error — but past technical
sessions still render in history and the session view.

## Tests

```
pnpm vitest run plugins/technical-mode
```
