const PLACEHOLDER = /^\s*$|\[add\b/i;

interface ExperienceLine {
  title: string;
  company: string;
  highlights: string[];
}

function decap(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** star-coach.generate: one story per experience bullet (max 4), placeholders for gaps. */
export function starCoachGenerateMock(input: unknown): unknown {
  const { experience = [], achievements = [], projects = [], behavioralSkillIds = [], existingTitles = [] } =
    input as {
      experience?: ExperienceLine[];
      achievements?: string[];
      projects?: { name: string; description: string }[];
      behavioralSkillIds?: string[];
      existingTitles?: string[];
    };
  const taken = new Set(existingTitles.map((t) => t.toLowerCase()));
  const stories = [];

  for (const exp of experience) {
    for (const highlight of exp.highlights) {
      if (stories.length >= 4) return { stories };
      const title = `${exp.company || exp.title}: ${highlight.slice(0, 60)}`;
      if (taken.has(title.toLowerCase())) continue;
      taken.add(title.toLowerCase());
      stories.push({
        title,
        situation: `[add situation — when/where at ${exp.company || "this role"}]`,
        task: `[add your goal as ${exp.title}]`,
        action: `I ${decap(highlight)}`,
        result: "[add metric]",
        skillIds: behavioralSkillIds.slice(0, 2),
      });
    }
  }
  for (const a of achievements) {
    if (stories.length >= 4) return { stories };
    const title = `Achievement: ${a.slice(0, 60)}`;
    if (taken.has(title.toLowerCase())) continue;
    taken.add(title.toLowerCase());
    stories.push({
      title,
      situation: "[add situation — the context for this achievement]",
      task: "[add your goal]",
      action: `I ${decap(a)}`,
      result: "[add metric]",
      skillIds: behavioralSkillIds.slice(0, 2),
    });
  }
  for (const p of projects) {
    if (stories.length >= 4) return { stories };
    const title = `Project: ${p.name.slice(0, 60)}`;
    if (taken.has(title.toLowerCase())) continue;
    taken.add(title.toLowerCase());
    stories.push({
      title,
      situation: `[add situation — why ${p.name} was needed]`,
      task: "[add your goal]",
      action: `I worked on ${p.name}: ${p.description}`.slice(0, 300),
      result: "[add metric]",
      skillIds: behavioralSkillIds.slice(0, 2),
    });
  }
  return { stories };
}

/** star-coach.review: flag empty/placeholder parts and number-less results. */
export function starCoachReviewMock(input: unknown): unknown {
  const { story, role, level } = input as {
    story: {
      title: string;
      situation: string;
      task: string;
      action: string;
      result: string;
      skillIds?: string[];
    };
    role: string;
    level: string;
  };
  const missing: string[] = [];
  const suggestions: string[] = [];
  for (const [name, text] of [
    ["Situation", story.situation],
    ["Task", story.task],
    ["Action", story.action],
    ["Result", story.result],
  ] as const) {
    if (PLACEHOLDER.test(text)) {
      missing.push(`${name} is missing or still a placeholder`);
      suggestions.push(`Write the ${name.toLowerCase()} in 1–2 concrete sentences`);
    }
  }
  if (story.result.trim() && !/\d/.test(story.result)) {
    missing.push("Result lacks a measurable outcome");
    suggestions.push("Add a number or percentage to the Result (time saved, %, users)");
  }
  if (story.result.trim().split(/\s+/).length < 6 && !PLACEHOLDER.test(story.result)) {
    suggestions.push("Expand the Result beyond a single phrase — what changed and for whom");
  }
  const improvedDraft = {
    situation: PLACEHOLDER.test(story.situation)
      ? "[add situation — one sentence: when, where, what was at stake]"
      : story.situation,
    task: PLACEHOLDER.test(story.task)
      ? "[add task — the goal or responsibility you owned]"
      : story.task,
    action: PLACEHOLDER.test(story.action)
      ? "[add action — what YOU did, first person]"
      : story.action,
    result: PLACEHOLDER.test(story.result) || !/\d/.test(story.result)
      ? "[add metric — quantify the outcome: %, time, users, revenue]"
      : story.result,
  };
  return {
    feedback:
      missing.length === 0
        ? `"${story.title}" is in good shape for a ${role.toLowerCase().startsWith(level) ? role : `${level} ${role}`} interview — all four STAR parts are present and grounded.`
        : `"${story.title}" needs work for a ${role.toLowerCase().startsWith(level) ? role : `${level} ${role}`} interview: ${missing.join("; ")}. Tighten it so each STAR part is concrete.`,
    missing,
    suggestions,
    improvedDraft,
  };
}
