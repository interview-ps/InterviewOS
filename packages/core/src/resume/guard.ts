export interface GuardResult {
  /** false when the suggestion was dropped entirely. */
  ok: boolean;
  /** Improved text after `[add metric]` substitutions (dropped or not). */
  improved: string;
  /** Why the suggestion was dropped. */
  dropped?: string;
  /** Numeric claims replaced with `[add metric]`. */
  substitutions: string[];
}

// All quantifiers over untrusted resume/suggestion text are bounded — an
// unbounded ambiguous quantifier is a quadratic ReDoS (CodeQL
// js/polynomial-redos). Bounds stay generous for real placeholders, numbers
// and entity names.
// "40%", "$120k", "€1.5M", "10x", "3M", "10,000" — not "IPv4"/"O(n4)".
const NUMBER_TOKEN_RE =
  /(?<![\w$€£])(?:[$€£]\s{0,2})?\d[\d,]{0,19}(?:\.\d{1,6})?\s{0,2}(?:%|percent\b|[xkmb]\b)|(?<![\w$€£])[$€£]\s{0,2}\d[\d,]{0,19}(?:\.\d{1,6})?|(?<![\w$€£.])\d[\d,]{0,19}(?:\.\d{1,6})?\b/gi;

// Capitalised multi-letter tokens: PostgreSQL, AWS, Node.js, C#, C++.
const ENTITY_RE =
  /(?<![\w.])[A-Z][A-Za-z0-9]{0,30}(?:(?:[.+#][A-Za-z0-9]{1,8})|[+#]{1,4}){0,6}/g;

const PLACEHOLDER_RE = /\[[^\]]{0,64}\]/g;

/**
 * Sentence-initial/common English words that are fine capitalised — modest on
 * purpose. Technology names (API, REST, SQL, AWS…) are deliberately NOT here:
 * they must appear in the resume or the suggestion is dropped.
 */
const ALLOWLIST = new Set([
  // determiners / prepositions / conjunctions / pronouns that open sentences
  "the", "a", "an", "in", "on", "at", "for", "to", "with", "by", "from",
  "as", "and", "or", "but", "not", "no", "nor", "so", "yet", "we", "our",
  "this", "that", "these", "those", "when", "while", "after", "before",
  "during", "across", "over", "under", "within", "into", "per", "via",
  "it", "its", "he", "she", "they", "their", "his", "her",
  // common resume action verbs (past + present + participle forms)
  "accelerated", "achieved", "analyzed", "analysed", "architected",
  "automated", "built", "builds", "coached", "collaborated", "consolidated",
  "coordinated", "created", "cut", "debugged", "decreased", "delivered",
  "delivers", "designed", "developed", "directed", "doubled", "drove",
  "enabled", "engineered", "established", "executed", "expanded", "founded",
  "generated", "grew", "headed", "implemented", "improved", "increased",
  "initiated", "introduced", "launched", "led", "leads", "maintained",
  "managed", "mentored", "migrated", "modernized", "modernised",
  "negotiated", "optimized", "optimised", "orchestrated", "owned", "owns",
  "pioneered", "produced", "prototyped", "reduced", "reduces", "refactored",
  "researched", "resolved", "scaled", "shaped", "shipped", "simplified",
  "spearheaded", "streamlined", "strengthened", "transformed", "tripled",
  "wrote", "drives", "guides", "guide", "grew", "growing", "saved", "saves",
  "earned", "secured", "raised", "boosted", "achieving", "ensuring", "using",
  // months / days / quarters commonly capitalised in date ranges
  "jan", "january", "feb", "february", "mar", "march", "apr", "april",
  "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept",
  "september", "oct", "october", "nov", "november", "dec", "december",
  "mon", "monday", "tue", "tues", "tuesday", "wed", "wednesday", "thu",
  "thur", "thurs", "thursday", "fri", "friday", "sat", "saturday", "sun",
  "sunday", "q1", "q2", "q3", "q4",
  // misc common capitalised words
  "ok", "etc", "present", "current",
]);

/** Normalise for presence checks: lowercase, strip thousands separators. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/\s+/g, " ");
}

function maskPlaceholders(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
  }
  return mask;
}

/** Numeric core of a token ("$1.5M" → "1.5", "40%" → "40", "10,000" → "10000"). */
function numericCore(token: string): string {
  const m = token.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? m[0] : "";
}

function containsNumber(haystackNorm: string, core: string): boolean {
  if (!core) return false;
  // full regex-meta escape (incl. backslash) — a partial escape is an
  // incomplete sanitization (CodeQL js/incomplete-sanitization)
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`).test(haystackNorm);
}

function containsEntity(haystackNorm: string, token: string): boolean {
  const t = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${t}([^\\w]|$)`).test(haystackNorm);
}

/**
 * §9.5 no-invented-facts guard, applied to every AI resume suggestion before
 * persisting: numeric claims not present in the resume (or the original
 * bullet) become `[add metric]`; capitalised entities absent from the resume
 * and outside a small common-word allowlist get the suggestion dropped.
 */
export function guardSuggestion(
  original: string,
  improved: string,
  resumeText: string,
): GuardResult {
  const resumeNorm = normalize(resumeText);
  const originalNorm = normalize(original);
  const mask = maskPlaceholders(improved);
  const substitutions: string[] = [];

  // --- numbers: substitute absent numeric claims with [add metric] ----------
  let out = "";
  let last = 0;
  for (const m of improved.matchAll(NUMBER_TOKEN_RE)) {
    const idx = m.index;
    const end = idx + m[0].length;
    if (mask[idx]) continue;
    const token = m[0].trim();
    const core = numericCore(token);
    const present =
      containsNumber(resumeNorm, core) || containsNumber(originalNorm, core);
    if (present) continue;
    out += improved.slice(last, idx) + "[add metric]";
    last = end;
    substitutions.push(token);
  }
  out += improved.slice(last);
  const guarded = out;
  const guardedMask = maskPlaceholders(guarded);

  // --- entities: drop suggestions that invent named things ------------------
  const offenders = new Set<string>();
  for (const m of guarded.matchAll(ENTITY_RE)) {
    const idx = m.index;
    const token = m[0];
    if (guardedMask[idx]) continue;
    if (token.replace(/[^\p{L}]/gu, "").length < 2) continue;
    if (ALLOWLIST.has(token.toLowerCase())) continue;
    if (
      containsEntity(resumeNorm, token) ||
      containsEntity(originalNorm, token)
    ) {
      continue;
    }
    offenders.add(token);
  }

  if (offenders.size > 0) {
    const list = [...offenders].join(", ");
    return {
      ok: false,
      improved: guarded,
      dropped: `invented ${offenders.size === 1 ? "name" : "names"} not in the resume: ${list}`,
      substitutions,
    };
  }
  return { ok: true, improved: guarded, substitutions };
}
