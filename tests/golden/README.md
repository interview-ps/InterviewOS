# Golden fixtures for `packages/core`

Language-neutral JSON captures of the TypeScript core's pure logic. The Python
port of `packages/core` (design doc `fastapi-backend-refactor.md` §13 item 2)
must reproduce these outputs exactly — this directory is its parity oracle.

## Layout

- `generate.ts` — builds every area file in memory via `buildFiles()` and, when
  run as a script, writes them (or diffs them with `--check`).
- `golden.test.ts` — vitest sync check: regenerates in memory, asserts byte
  equality with the committed files, fails if an area file is missing.
- `cases/` — one module per area; case builders only (inputs, names).
- `readiness.json`, `gaps.json`, `prioritize.json`, `state-machine.json`,
  `taxonomy.json`, `rounds.json`, `voice.json`, `resources.json` — committed
  outputs.

## Regenerating

```sh
node --import tsx tests/golden/generate.ts          # write all 8 files
node --import tsx tests/golden/generate.ts --check  # exit 1 on any drift
```

## File format

```json
{ "area": "readiness", "generatedFrom": "packages/core", "cases": [
  { "fn": "statusForScore", "name": "score 0.5", "input": { "score": 0.5 },
    "output": "developing" },
  { "fn": "transition", "name": "transition debrief + ask",
    "input": { "status": "debrief", "event": "ask" },
    "error": { "name": "InvalidTransitionError", "message": "..." } }
] }
```

- `input` holds the function's named arguments. `now` is always the fixed
  clock `"2026-01-01T00:00:00.000Z"` and evidence `createdAt` values are fixed
  offsets (0, 1, 30, 60, 180, 400 days) relative to it; the TS runner converts
  `now` to `Date`, and the Python side should do the equivalent.
- Keys are sorted, indent is 2 spaces, files end with a newline. Floats are
  full-precision JS numbers — never rounded.
- Case `name`s are unique within a file. A case has `output` on success or
  `error` (`name` + `message`) when the function throws.

## Comparison rules for the Python side

- Strings, integers, booleans, `null` and structure compare **exactly**.
- Floats compare with `math.isclose(rel_tol=1e-12, abs_tol=1e-12)`.
- Object key order is irrelevant; array order matters.
- `error` cases compare `error.name` and `error.message` exactly, **except
  `ZodError`**: its message is Zod's own serialization. The Python side must
  raise a Pydantic `ValidationError` and match only the failing field paths
  and constraint kinds parsed from the recorded message (e.g. `durationSec`,
  `too_small`, `>= 0`).

## Gotchas the fixtures encode

- `taxonomy.getNode` **mutates** the module registry for unknown-but-valid ids
  (an on-demand node is created). In `taxonomy.json`, `allNodes` runs first and
  mutating `getNode` cases run last.
- Without registered plugins, `getMode` resolves only `"mixed"`; other round
  types get the unavailable placeholder (`inScope` false, `fallbackSkills` []),
  so `rounds.json` records false/[] for them and `selectNextSkill` in a
  non-mixed mode returns `null`. Mode-scoped selection with plugin modes is
  therefore **not** covered here. It is covered end-to-end by the contract
  suite (`tests/contract/`) and must get its own golden cases when plugin modes
  are ported (refactor phase 7).
