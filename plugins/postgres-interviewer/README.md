# postgres-interviewer

Example SDK-style Interview OS plugin (`skill.yaml` + `defineSkill`).

- Returns a small deterministic bank of PostgreSQL questions tagged with `sql.*` skill ids.
- Pass `request.skillId` (via the `request` input) to filter questions to one skill.
- Pass `request.selfCheck: [{ skillId, passed }]` to emit `evidenceProposals`; the host only persists them when `evidence.write` has been granted to this plugin.
