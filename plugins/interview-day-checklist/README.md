# interview-day-checklist

Sample Interview OS plugin (§9.6). Produces a short checklist for interview day:

- the top 3 weak requirement areas to skim,
- a STAR reminder,
- a logistics reminder.

## What it can see

Only the state slices its manifest declares — `target`, `readiness`, `gaps`
(all read-only). It gets **no** candidate profile, stories, answers, or
runtime access: `ctx.runtime` throws `PERMISSION_DENIED` for this plugin.

## Layout

- `manifest.json` — id, version, declared inputs/outputs, permissions.
- `index.ts` — default export `{ execute(input, ctx) }`. Runs under the
  server's tsx runtime; a 30 s timeout applies and output is capped at 100 KB.

Plugins are local code you trust — Interview OS loads every subdirectory of
`INTERVIEW_OS_PLUGINS_DIR` (default `<repo>/plugins`) at server start.
