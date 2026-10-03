import { taxonomy } from "@interview-os/core";
import type { SkillId } from "@interview-os/core";

const round2 = (n: number) => Math.round(n * 100) / 100;

interface RoundInput {
  mode: string;
  label: string;
  summaries: string[];
  rubricAverages: Record<string, number>;
  handoff: {
    weakSkills: { skillId: string; label?: string; score: number; observation: string }[];
    strongSkills: { skillId: string; label?: string; score: number }[];
    observations: string[];
  } | null;
}

const name = (s: { skillId: string; label?: string }) =>
  s.label || taxonomy.labelFor(s.skillId as SkillId);

/** Signal from the mean rubric score: ≥0.7 strong, ≥0.45 mixed, else weak. */
export function loopDebriefMock(input: unknown): unknown {
  const { role, company, rounds, readinessChange } = input as {
    role: string;
    company?: string;
    rounds: RoundInput[];
    readinessChange: { before: number | null; after: number | null };
  };

  const outRounds = rounds.map((r) => {
    const vals = Object.values(r.rubricAverages);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.3;
    const signal = mean >= 0.7 ? "strong" : mean >= 0.45 ? "mixed" : "weak";
    const evidence = [
      `mean rubric ${round2(mean)}`,
      ...(r.handoff?.weakSkills ?? []).map(
        (w) => `weak ${name(w)} (${round2(w.score)})`,
      ),
      ...(r.handoff?.strongSkills ?? []).map(
        (s) => `strong ${name(s)} (${round2(s.score)})`,
      ),
      ...(r.summaries[0] ? [r.summaries[0].slice(0, 120)] : []),
    ].slice(0, 5);
    return { mode: r.mode, label: r.label, signal, evidence };
  });

  const weak = outRounds.filter((r) => r.signal === "weak").length;
  const strong = outRounds.filter((r) => r.signal === "strong").length;
  return {
    summary:
      `Mock loop debrief for ${role}${company ? ` at ${company}` : ""}: ` +
      `${rounds.length} round(s) — ${strong} strong, ${outRounds.length - strong - weak} mixed, ${weak} weak.`,
    rounds: outRounds,
    readinessChange,
    topActions: rounds
      .flatMap((r) => r.handoff?.weakSkills ?? [])
      .slice(0, 5)
      .map((w) => `Review ${name(w)} fundamentals and retry a focused question`),
  };
}
