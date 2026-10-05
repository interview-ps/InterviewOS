// plugins/postgres-interviewer/ui/src/index.tsx
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  SkillScore,
  Tabs
} from "@interview-os/ui";
import { jsx, jsxs } from "react/jsx-runtime";
var TAB_SKILLS = [
  { label: "Queries", skills: ["sql", "sql.query-optimization"] },
  { label: "Indexes", skills: ["sql.indexing"] },
  { label: "Transactions", skills: ["sql.transactions"] },
  { label: "Locking", skills: ["sql.locking"] }
];
function PostgresSkillTree({ sdk }) {
  const [readiness, setReadiness] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    sdk.getData().then(
      (slices) => setReadiness(
        slices.readiness ?? {}
      )
    ).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [sdk]);
  if (error) return /* @__PURE__ */ jsx(EmptyState, { title: "Readiness unavailable", description: error });
  if (!readiness) return /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsx(CardTitle, { children: "PostgreSQL readiness" }) });
  return /* @__PURE__ */ jsxs(Card, { "data-testid": "pg-skill-tree", children: [
    /* @__PURE__ */ jsx(CardTitle, { children: "PostgreSQL readiness" }),
    /* @__PURE__ */ jsx(
      Tabs,
      {
        tabs: TAB_SKILLS.map((tab) => ({
          label: tab.label,
          children: /* @__PURE__ */ jsx("div", { className: "space-y-3", children: tab.skills.map((skillId) => {
            const dim = readiness[skillId];
            return /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx(
                SkillScore,
                {
                  label: dim?.label ?? skillId,
                  score: dim?.score ?? null,
                  confidence: dim?.confidence
                }
              ),
              /* @__PURE__ */ jsx("div", { className: "mt-1", children: /* @__PURE__ */ jsxs(
                Button,
                {
                  variant: "ghost",
                  "data-testid": `practice-${skillId}`,
                  onClick: () => void sdk.action({ type: "startPractice", skillId }),
                  children: [
                    "Practice ",
                    dim?.label ?? skillId
                  ]
                }
              ) })
            ] }, skillId);
          }) })
        }))
      }
    )
  ] });
}
var index_default = {
  components: { "postgres-skill-tree": PostgresSkillTree }
};
export {
  index_default as default
};
