# coding-mode

Bundled Interview OS plugin that provides the **`coding` interview mode** — a
live-coding round: the interviewer presents a small algorithmic problem, the
candidate explains their approach and writes code (reviewed, never executed),
and the evaluator scores against the coding rubric.

This plugin is the reference implementation of the **plugin interview mode**
extension point. The mode is declared in `skill.yaml` under `modes:` and the
host turns the descriptor into a `ModeDefinition` at load time.

## What it declares

- **Capability** `interview_mode` (+ `ui` for the problem panel).
- **Mode** `coding`:
  - scope: the `coding` taxonomy subtree (`scope: { include: [coding] }`)
  - answer format: `text+code` (the host renders the code editor + language picker)
  - rubric: `problemUnderstanding`, `approach`, `correctness`, `complexity`,
    `edgeCases`, `codeQuality`, `communication` (evaluator must return exactly
    these ids)
  - initial state `{ problem: null, phase: "briefing" }`; declarative `reduce`
    copies `question.extra.problem` into state and sets `phase: "working"`
  - declarative `followUpRules`: ask about "complexity analysis" when the
    complexity rubric scores `< 0.6`, then "edge cases" for `edgeCases < 0.6`
- **Prompts** `prompts/interviewer.md` + `prompts/evaluator.md`, read by the
  server loader at plugin load and embedded by the host's mode prompt wrapper.
- **Hooks** `mode.mock` (deterministic MockRuntime output for
  `interviewer.coding` / `answer-evaluator.coding`) and `ui.render` (the
  `coding-problem` declarative panel for the `interview.question` slot).
- **Permission** `answers.read` — auto-granted for bundled plugins; without it
  the host strips `answer`/`code` from `mode.mock` evaluator input.

## Disabling

Disable the plugin in Settings → Plugins (or uninstall it). New sessions,
loops, and company-round creation then reject `coding` with a typed error and
`GET /api/modes` no longer lists it — but past coding sessions still render in
history and the session view (read-only code included), because stored mode ids
parse and `getMode("coding")` falls back to an "unavailable" definition.

## Tests

```
pnpm vitest run plugins/coding-mode
```
