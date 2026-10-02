import { taxonomy, type SkillId } from "@interview-os/core";
import { bulletsOf, firstMatchingLine, splitSections, stripMd } from "../../mock/text.js";

function levelFor(mentions: number): number {
  return Math.min(0.9, 0.45 + 0.15 * mentions);
}

function bulletsOfSection(sections: ReturnType<typeof splitSections>, re: RegExp): string[] {
  return sections
    .filter((s) => re.test(s.heading))
    .flatMap((s) => bulletsOf(s.lines))
    .map(stripMd);
}

export function resumeAnalyzerMock(input: unknown): unknown {
  const { resumeText } = input as { resumeText: string };
  const sections = splitSections(resumeText);

  const skills = taxonomy.matchSkills(resumeText).map((m) => ({
    skillId: m.skillId as SkillId,
    level: levelFor(m.mentions),
    source: "resume" as const,
    evidence: firstMatchingLine(resumeText, m.skillId as SkillId),
  }));

  const experience = bulletsOfSection(sections, /experience|employment|work history/).map(
    (line) => {
      const [title, company, ...rest] = line.split(/\s+[—–-]\s+|\s+@\s+/);
      return {
        title: title ?? line,
        company: company ?? "",
        highlights: rest.length ? [rest.join(" — ")] : [],
      };
    },
  );

  const education = bulletsOfSection(sections, /education/).map((line) => {
    const [degree, institution] = line.split(/\s+[—–,]\s+/);
    return { institution: institution ?? "", degree: degree ?? line };
  });

  const projects = bulletsOfSection(sections, /project/).map((line) => {
    const [name, ...rest] = line.split(/[—–:]\s+/);
    return { name: name ?? line, description: rest.join(": ") || line, technologies: [] };
  });

  const achievements = bulletsOfSection(sections, /achievement|accomplishment|award/);

  const lines = resumeText.split("\n").map((l) => l.trim());
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const headingLine = lines.find((l) => l && !l.startsWith("#"));

  return {
    name: h1 ? h1.replace(/^#+\s*/, "").trim() : (headingLine ?? null),
    headline: null,
    experience,
    skills,
    projects,
    achievements,
    education,
    starStories: [],
  };
}
