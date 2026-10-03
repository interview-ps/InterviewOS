const BULLET_RE = /^\s*(?:[-*•‣◦]|\d+\.)\s+/;
const NUMBER_RE = /\d/;
const ACTION_VERB_RE =
  /^\s*(?:[-*•‣◦]|\d+\.)\s*(accelerated|achieved|analy[sz]ed|architected|automated|built|coached|collaborated|consolidated|coordinated|created|cut|debugged|decreased|delivered|designed|developed|directed|doubled|drove|enabled|engineered|established|executed|expanded|founded|generated|grew|headed|implemented|improved|increased|initiated|introduced|launched|led|maintained|managed|mentored|migrated|modernized|modernised|negotiated|optimi[sz]ed|orchestrated|owned|pioneered|produced|prototyped|reduced|refactored|researched|resolved|scaled|shaped|shipped|simplified|spearheaded|streamlined|strengthened|transformed|tripled|wrote)\b/i;

/** Resume bullet lines, trimmed of their bullet marker. */
export function bulletLines(resumeText: string): string[] {
  return resumeText
    .split(/\r?\n/)
    .filter((l) => BULLET_RE.test(l))
    .map((l) => l.trim());
}

// Bounded quantifiers throughout (CodeQL js/polynomial-redos): the lazy group
// may end at any space, so every `\s` run must be bounded to keep each
// backtracking step O(1). \S forces the heading text to start non-space.
const HEADING_RE =
  /^\s{0,4}#{1,6}\s{0,4}(\S.{0,120}?)\s{0,4}$|^\s{0,4}([A-Z][A-Za-z &/]{2,40})\s{0,4}:?\s{0,4}$/;
/** Sections whose bullets are experience signals worth coaching. */
const EXPERIENCE_SECTION_RE =
  /experience|work|employment|professional|career|projects?|history/i;
/** Sections whose bullets must never be "improved" as achievements. */
const NON_EXPERIENCE_SECTION_RE =
  /education|academics?|skills|technologies|contact|summary|objective|profile|references|languages|awards|certifications|interests|publications|links/i;

/**
 * §9.5: deterministically pick up to `max` weakest bullets for coaching —
 * only bullets inside experience/projects sections (never education, skills,
 * contact, summary). Weak = lacks a number and/or an action-verb start; ties
 * keep resume order.
 */
export function selectWeakestBullets(
  resumeText: string,
  max = 8,
): string[] {
  let section: string | null = null;
  const candidates: { text: string; index: number }[] = [];
  resumeText.split(/\r?\n/).forEach((line, index) => {
    const heading = line.match(HEADING_RE);
    if (heading) {
      section = heading[1] ?? heading[2] ?? null;
      return;
    }
    if (!BULLET_RE.test(line)) return;
    if (section === null) {
      // before any heading — e.g. a free-form top block; only take it if we
      // haven't seen a restricted section name anywhere yet
      candidates.push({ text: line.trim(), index });
      return;
    }
    if (EXPERIENCE_SECTION_RE.test(section)) {
      candidates.push({ text: line.trim(), index });
    } else if (!NON_EXPERIENCE_SECTION_RE.test(section)) {
      candidates.push({ text: line.trim(), index });
    }
    // bullets in education/skills/contact/etc. are never coached
  });
  return candidates
    .map((c) => ({
      ...c,
      missing:
        (NUMBER_RE.test(c.text) ? 0 : 1) + (ACTION_VERB_RE.test(c.text) ? 0 : 1),
    }))
    .sort((a, b) => b.missing - a.missing || a.index - b.index)
    .slice(0, max)
    .map((b) => b.text);
}
