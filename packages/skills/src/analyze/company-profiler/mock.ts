import { taxonomy, type SkillId } from "@interview-os/core";
import { bulletsOf, stripMd } from "../../mock/text.js";

const VALUE_LINE = /value|principle|believe|we care|we look for|we hire|mindset/i;

const THEME_PATTERNS: Array<{ theme: string; re: RegExp }> = [
  { theme: "ownership", re: /ownership|own it|accountab|end-to-end/i },
  { theme: "customer focus", re: /customer|user[- ]first|obsession/i },
  { theme: "bias for action", re: /bias for action|move fast|ship|velocity|urgency/i },
  { theme: "collaboration", re: /collaborat|together|cross-functional|team first/i },
  { theme: "reliability", re: /reliab|resilien|uptime|correctness/i },
  { theme: "learning", re: /learn|grow|curious|growth mindset/i },
];

/** company-profiler: values from value-ish lines, skills via matchSkills, themes via keywords. */
export function companyProfilerMock(input: unknown): unknown {
  const { companyNotes } = input as { companyNotes: string };
  const lines = bulletsOf(companyNotes.split("\n")).map(stripMd).filter(Boolean);

  const values = [
    ...new Set(lines.filter((l) => VALUE_LINE.test(l)).map((l) => l.slice(0, 120))),
  ].slice(0, 6);

  const focusSkillIds = taxonomy
    .matchSkills(companyNotes)
    .slice(0, 8)
    .map((m) => m.skillId as SkillId);

  const behavioralThemes = THEME_PATTERNS.filter((t) => t.re.test(companyNotes)).map(
    (t) => t.theme,
  );

  const interviewStyle = /interview|loop|onsite|process/i.test(companyNotes)
    ? (lines.find((l) => /interview|loop|onsite|process/i.test(l)) ?? "").slice(0, 160)
    : "";

  return { values, interviewStyle, focusSkillIds, behavioralThemes };
}
