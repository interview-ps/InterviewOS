interface Gap {
  skillId: string;
  label: string;
  importance: number;
  gap: number;
  severity: string;
}

interface ChecklistItem {
  title: string;
  detail: string;
}

/**
 * interview-day-checklist (§9.6 sample plugin): builds a short checklist from
 * the active target's gaps and the company name. Read-only — no runtime, no
 * writes.
 */
export default {
  handlers: {
    /**
     * preparation.suggest — the same weakest-area logic expressed as prep
     * activities; the legacy `/run` checklist output is preserved below.
     */
    "preparation.suggest"(req: { gaps?: Gap[] }) {
      const gaps = req.gaps ?? [];
      const weakest = [...gaps]
        .sort((a, b) => b.importance * b.gap - a.importance * a.gap)
        .slice(0, 3);
      const activities = weakest.map((g) => ({
        skillId: g.skillId,
        title: `Skim ${g.label || g.skillId}`,
        action: `Weak area for this role (severity ${g.severity}) — 10 minutes of review before the interview.`,
        successCriteria: ["Can explain the core concept unprompted"],
      }));
      return { activities };
    },
  },
  execute(input: Record<string, unknown>) {
    const target = input.target as
      | { company: string; role: string; level: string }
      | undefined;
    const gaps = (input.gaps as Gap[] | undefined) ?? [];

    const weakest = [...gaps]
      .sort((a, b) => b.importance * b.gap - a.importance * a.gap)
      .slice(0, 3);

    const items: ChecklistItem[] = weakest.map((g, i) => ({
      title: `Skim ${g.label || g.skillId}`,
      detail: `Weak area #${i + 1} for this role (severity ${g.severity}) — 10 minutes of review.`,
    }));

    items.push({
      title: "STAR reminder",
      detail:
        "Every behavioral answer: Situation → Task → Action → Result. Land the result with a number.",
    });
    items.push({
      title: "Logistics",
      detail: target
        ? `${target.role} at ${target.company} — test your camera/mic, water nearby, notebook for questions.`
        : "Test your camera/mic, water nearby, notebook for questions.",
    });

    return {
      title: target
        ? `Interview day — ${target.role} @ ${target.company}`
        : "Interview day checklist",
      items,
    };
  },
};
