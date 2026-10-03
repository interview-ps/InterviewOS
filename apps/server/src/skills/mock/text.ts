import type { SkillId } from "@interview-os/core";
import { taxonomy } from "@interview-os/core";

export function firstMatchingLine(text: string, skillId: SkillId): string {
  const keywords = taxonomy.getNode(skillId)?.keywords ?? [];
  for (const line of text.split("\n")) {
    const lower = line.toLowerCase();
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) {
      return line.trim().slice(0, 160);
    }
  }
  for (const line of text.split("\n")) {
    if (line.trim().toLowerCase().includes(skillId.split(".").pop()!)) {
      return line.trim().slice(0, 160);
    }
  }
  return text.split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";
}

export interface MarkdownSection {
  heading: string;
  lines: string[];
}

export function splitSections(text: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [{ heading: "", lines: [] }];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const h = line.match(/^#{1,3}\s{1,4}(\S.{0,120})$/);
    if (h) {
      sections.push({ heading: h[1]!.trim().toLowerCase(), lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  return sections;
}

export function bulletsOf(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim())
    .filter((l) => l.length > 0);
}

export function stripMd(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "").trim();
}
