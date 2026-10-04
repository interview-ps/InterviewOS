# Role Packs

A role pack describes what a role requires: skill dimensions with weights,
default interview modes, rubric hints, learning resources, and questions.
Applying one to a target adds requirements and shapes question sources and
prep resources.

Schema: `RolePackSchema` in `packages/core/src/packs/index.ts`.

## Layout

```
packs/roles/<id>/
  role.yaml             # RolePack
```

Bundled: `packs/roles/` (backend-engineer, frontend-engineer, sre,
data-engineer, data-scientist, product-manager, engineering-manager).
Installed: `data/packs/roles/` via
`POST /api/packs/install {kind:"role", url}`.

## `role.yaml` fields

| field | notes |
|---|---|
| `format` | `"interview-os.role-pack"` |
| `id`, `name`, `version`, `description`, `maintainers` | metadata |
| `sources` | `[{id, title, url?}]` — `https://` only |
| `taxonomy` | `[{id, label, keywords[]}]` — extra skill nodes registered when the pack is applied (for skills not in the seed taxonomy) |
| `dimensions` | `[{skillId, weight 0–1}]`, 1–30 — becomes the applied requirements (importance = weight) |
| `defaultQuestionCategories` | 2–7 mode ids — default round sequence for loops at this role |
| `rubrics` | `[{skillId? , mode?, criteria[]}]` (needs at least one of skillId/mode) — fed to interviewer/evaluator prompts |
| `resources` | `[{title, url?, summary?, kind}]` (`PrepResource` minus `source` — stamped `pack:<id>` at load) |
| `questions` | `[{skillId, text, difficulty?, mode?, provenance, source?}]` |

## Applying to a target

`PUT /api/targets/:id/role-pack { rolePackId }` (or `null` to clear):

- Requirements with `origin: "role_pack"` are **replaced** — re-applying or
  switching packs never compounds them; clearing removes them.
- Declared `taxonomy` nodes are registered (idempotent).
- Readiness is recomputed so the new requirements get gaps.

## Provenance

Role-pack `questions` follow the same rule as company packs: `sourced` items
must cite a declared `sources[].id`; `community` items render as unverified.
Requirements/resources contributed by a pack are attributed (`origin:
"role_pack"`, `source: "pack:<id>"`).
