# Company Packs

A company pack describes how a company (or company style) tends to interview:
its loop stages, competencies, question style, and evaluation guidance. Packs
compile into the `CompanyProfile` the app already consumes, so they shape loops,
question emphasis, and debrief guidance.

Schema: `CompanyPackSchema` (and `CompanyPackOverlaySchema`) in
`packages/core/src/packs/index.ts`.

## Layout

```
packs/companies/<id>/
  company.yaml          # required — CompanyPack
  <overlay>.yaml        # optional — CompanyPackOverlay per overlay file
```

Bundled packs ship under `packs/companies/`; installed ones land in
`data/packs/companies/` (via `POST /api/packs/install {kind:"company", url}`).

## `company.yaml` fields

| field | notes |
|---|---|
| `format` | `"interview-os.company-pack"` (defaulted) |
| `id` | slug (`a-z0-9-`, ≤ 64) |
| `name`, `version`, `description`, `maintainers`, `aliases` | metadata; aliases match alternate company names |
| `sources` | `[{id, title, url?}]` — `url` must be `https://` |
| `stages` | `[{mode, label, plannedQuestions(1–6), provenance, source?}]` — the typical loop |
| `competencies`, `questionStyle`, `evaluationGuidance` | `[{text, provenance, source?}]` lists |
| `emphasis` | `[{skillId, weight ≤ 0.1}]` — nudges question selection |
| `behavioralFramework` | `{name, themes[], guidance}` |
| `followUpDepth` | 1–3 (default 2) |
| `roleExpectations` | `{role: [expectations]}` |
| `questions` | `[{skillId, text, difficulty?, mode?, provenance, source?}]` — offered as candidates when company packs are enabled in question sources |

## Overlays

An overlay file (`backend.yaml`, `frontend.yaml`, …) narrows the pack for a
role: `roleKeywords` trigger it, and it can add `competencies`,
`questionStyle`, `evaluationGuidance`, `stages`, `questions`.

## Provenance rules

Every item carries `provenance: "sourced" | "community"`:

- `sourced` **requires** `source` referencing a declared `sources[].id` —
  the loader rejects the pack otherwise (overlays too).
- `community` items are *unverified observations*: the UI shows them with a
  "Community (unverified)" pill and the interviewer prompt labels them as such.
- Never present community content as fact.

## Install / uninstall

`POST /api/packs/install {kind:"company", url}` clones (https URL or local
path) into `data/packs/companies/<id>/`, validates, and registers the pack.
`DELETE /api/packs/:kind/:id` removes installed packs; bundled packs are
read-only. Example: `packs/companies/stripe`.
