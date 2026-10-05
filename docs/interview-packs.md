# Interview Packs

An interview pack is a shareable multi-round loop recipe: which skills to
cover, which modes the rounds use, and how long it takes.

Schema: `InterviewPackSchema` in `packages/core/src/packs/index.ts`.

## Fields

| field | notes |
|---|---|
| `format` | `"interview-os.interview-pack"` |
| `id` | slug (`a-z0-9-`, ≤ 64) |
| `name`, `version`, `description`, `author` | metadata |
| `skills` | 1–12 taxonomy skill ids the loop covers |
| `rounds` | 2–7 rounds of `{mode, label, plannedQuestions(1–6)}` |
| `durationMinutes` | 15–600 |

Example: `packs/interview/senior-backend.yaml`.

## Where they live

- **Bundled** — `packs/interview/*.yaml`; read-only (cannot be deleted).
- **User/imported** — stored in the `interview_packs` table; created via the
  UI/API or imported from a file.

## API

| route | behavior |
|---|---|
| `GET /api/interview-packs` | list all (bundled + stored) |
| `POST /api/interview-packs` | create (validated against `InterviewPackSchema`) |
| `GET /api/interview-packs/:id/export` | download the pack as YAML |
| `POST /api/interview-packs/import` | import YAML/JSON text; a different `version` for an existing `id` is a conflict error |
| `POST /api/interview-packs/:id/start` | start a full interview loop from the pack's rounds/skills |
| `DELETE /api/interview-packs/:id` | delete a user/imported pack (bundled → error) |

Starting a pack creates a normal interview loop, so history, debrief, and
readiness all work the same. Import/export makes packs portable between
machines — a bundle export (`GET /api/export`) includes user/imported
interview packs too.
