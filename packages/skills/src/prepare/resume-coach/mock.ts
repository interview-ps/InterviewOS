import { taxonomy } from "@interview-os/core";

const VERB_FALLBACK = "Delivered";

function stripMarker(bullet: string): string {
  return bullet.replace(/^\s*(?:[-*•‣◦]|\d+\.)\s*/, "").trim();
}

function firstWordIsVerb(text: string): boolean {
  const w = text.match(/^[A-Za-z]+/)?.[0]?.toLowerCase() ?? "";
  return [
    "accelerated", "achieved", "analyzed", "analysed", "architected",
    "automated", "built", "coached", "collaborated", "consolidated",
    "coordinated", "created", "cut", "debugged", "decreased", "delivered",
    "designed", "developed", "directed", "doubled", "drove", "enabled",
    "engineered", "established", "executed", "expanded", "founded",
    "generated", "grew", "headed", "implemented", "improved", "increased",
    "initiated", "introduced", "launched", "led", "maintained", "managed",
    "mentored", "migrated", "modernized", "modernised", "negotiated",
    "optimized", "optimised", "orchestrated", "owned", "pioneered",
    "produced", "prototyped", "reduced", "refactored", "researched",
    "resolved", "scaled", "shaped", "shipped", "simplified", "spearheaded",
    "streamlined", "strengthened", "transformed", "tripled", "wrote",
  ].includes(w);
}

/** Deterministic rewrite: keep facts, force an action-verb start + [add metric]. */
function rewriteBullet(bullet: string): { improved: string; rationale: string } {
  const text = stripMarker(bullet);
  const parts: string[] = [];
  let improved = text;

  // "Role — Company — action" → fold the employer in as "… at <Company>"
  const roleCompany = text.match(/^(.+?)\s+[—–-]\s+(.+?)\s+[—–-]\s+(.+)$/);
  if (roleCompany) {
    const company = roleCompany[2]!;
    const action = roleCompany[3]!;
    improved = firstWordIsVerb(action)
      ? `${action[0]!.toUpperCase()}${action.slice(1)} at ${company}`
      : `${VERB_FALLBACK} ${action.replace(/^(responsible for|worked on|helped with)\s+/i, "")} at ${company}`;
    parts.push("moved the employer into the sentence");
  } else {
    // "Name — description" project bullet → "Built <Name>, <description>"
    const named = text.match(/^([A-Z][\w+.@-]*)\s+[—–-]\s+(.+)$/);
    if (named) {
      improved = `Built ${named[1]}, ${named[2]!}`;
      parts.push("starts with an action verb");
    } else if (!firstWordIsVerb(text)) {
      const body = text.replace(
        /^(responsible for|worked on|helped with)\s+/i,
        "",
      );
      // never change casing — proper nouns (LedgerSync, DocPipe) stay intact
      improved = `${VERB_FALLBACK} ${body}`;
      parts.push("starts with an action verb");
    } else {
      improved = text[0]!.toUpperCase() + text.slice(1);
    }
  }
  if (!/\d/.test(improved)) {
    improved = `${improved.replace(/[.\s]+$/, "")}, achieving [add metric]`;
    parts.push("adds a measurable outcome placeholder");
  }
  return {
    improved,
    rationale:
      parts.length === 0
        ? "Already strong: action verb plus a number."
        : `Rewritten to be more scannable — ${parts.join(" and ")}.`,
  };
}

export function resumeCoachBulletsMock(input: unknown): unknown {
  const { bullets = [] } = input as { bullets?: string[] };
  return {
    suggestions: bullets.map((b) => {
      const { improved, rationale } = rewriteBullet(b);
      return {
        original: b,
        improved,
        rationale,
        skillIds: taxonomy.matchSkills(b).slice(0, 3).map((m) => m.skillId),
      };
    }),
  };
}

export function resumeCoachTailorMock(input: unknown): unknown {
  const { resumeText = "", requirements = [], role = "" } = input as {
    resumeText?: string;
    requirements?: {
      skillId: string;
      label: string;
      kind?: string;
      importance?: number;
    }[];
    role?: string;
    level?: string;
  };
  const lines = resumeText.split(/\r?\n/);
  const matched = new Set(taxonomy.matchSkills(resumeText).map((m) => m.skillId));
  const isCovered = (skillId: string) => {
    if (matched.has(skillId)) return true;
    for (const m of matched) {
      if (taxonomy.ancestors(m as never).includes(skillId as never)) return true;
    }
    return false;
  };
  const evidenceFor = (skillId: string): string | null => {
    const kws = [
      ...(taxonomy.getNode(skillId as never)?.keywords ?? []),
      ...taxonomy.childrenOf(skillId as never).flatMap(
        (c) => taxonomy.getNode(c)?.keywords ?? [],
      ),
    ];
    for (const line of lines) {
      if (kws.some((k) => line.toLowerCase().includes(k.toLowerCase()))) {
        return line.trim();
      }
    }
    return null;
  };

  const required = requirements.filter((r) => r.kind !== "preferred");
  const covered = required.filter((r) => isCovered(r.skillId));
  const gaps = required.filter((r) => !isCovered(r.skillId));
  return {
    summary:
      gaps.length === 0
        ? `The resume already covers all ${required.length} required skills for ${role}.`
        : `The resume covers ${covered.length} of ${required.length} required skills for ${role}; ${gaps.length} requirement(s) have no resume evidence — prepare for them rather than padding the resume.`,
    emphasize: covered.map((r) => r.label || r.skillId),
    deEmphasize: [],
    alignment: required.map((r) => ({
      requirement: r.label || r.skillId,
      resumeEvidence: evidenceFor(r.skillId),
      suggestion: isCovered(r.skillId)
        ? `Keep "${r.label || r.skillId}" prominent — it is a stated requirement.`
        : `Not in your resume — if you have this experience, add it; otherwise see Prepare.`,
    })),
    prepGaps: gaps.map((r) => r.label || r.skillId),
  };
}
