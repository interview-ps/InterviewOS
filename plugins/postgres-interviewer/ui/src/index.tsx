import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  SkillScore,
  Tabs,
} from "@interview-os/ui";
import type { PluginFrameModule, PluginFrameProps } from "@interview-os/ui";

interface ReadinessDimension {
  label?: string;
  score: number | null;
  confidence: number;
}

const TAB_SKILLS: { label: string; skills: string[] }[] = [
  { label: "Queries", skills: ["sql", "sql.query-optimization"] },
  { label: "Indexes", skills: ["sql.indexing"] },
  { label: "Transactions", skills: ["sql.transactions"] },
  { label: "Locking", skills: ["sql.locking"] },
];

function PostgresSkillTree({ sdk }: PluginFrameProps) {
  const [readiness, setReadiness] = useState<Record<
    string,
    ReadinessDimension
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sdk
      .getData()
      .then((slices) =>
        setReadiness(
          (slices.readiness as Record<string, ReadinessDimension>) ?? {},
        ),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [sdk]);

  if (error) return <EmptyState title="Readiness unavailable" description={error} />;
  if (!readiness) return <Card><CardTitle>PostgreSQL readiness</CardTitle></Card>;

  return (
    <Card data-testid="pg-skill-tree">
      <CardTitle>PostgreSQL readiness</CardTitle>
      <Tabs
        tabs={TAB_SKILLS.map((tab) => ({
          label: tab.label,
          children: (
            <div className="space-y-3">
              {tab.skills.map((skillId) => {
                const dim = readiness[skillId];
                return (
                  <div key={skillId}>
                    <SkillScore
                      label={dim?.label ?? skillId}
                      score={dim?.score ?? null}
                      confidence={dim?.confidence}
                    />
                    <div className="mt-1">
                      <Button
                        variant="ghost"
                        data-testid={`practice-${skillId}`}
                        onClick={() =>
                          void sdk.action({ type: "startPractice", skillId })
                        }
                      >
                        Practice {dim?.label ?? skillId}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ),
        }))}
      />
    </Card>
  );
}

export default {
  components: { "postgres-skill-tree": PostgresSkillTree },
} satisfies PluginFrameModule;
