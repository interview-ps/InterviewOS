import { z } from "zod";
import type { Requirement } from "../target/index.js";
import * as taxonomy from "../taxonomy/index.js";
import { bulletLines } from "./bullets.js";

export const AtsCheckStatusSchema = z.enum(["pass", "warn", "fail"]);
export type AtsCheckStatus = z.infer<typeof AtsCheckStatusSchema>;

export const AtsCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: AtsCheckStatusSchema,
  detail: z.string(),
  weight: z.number(),
});
export type AtsCheck = z.infer<typeof AtsCheckSchema>;

export const AtsKeywordCoverageSchema = z.object({
  present: z.array(
    z.object({
      skillId: z.string(),
      label: z.string(),
      /** First resume line matching this skill's keywords, trimmed. */
      snippet: z.string(),
    }),
  ),
  missing: z.array(z.object({ skillId: z.string(), label: z.string() })),
});
export type AtsKeywordCoverage = z.infer<typeof AtsKeywordCoverageSchema>;

export const AtsResultSchema = z.object({
  /** 0–100 weighted pass ratio (pass 1, warn 0.5, fail 0). */
  score: z.number().int().min(0).max(100),
  checks: z.array(AtsCheckSchema),
  keywordCoverage: AtsKeywordCoverageSchema,
});
export type AtsResult = z.infer<typeof AtsResultSchema>;

const SECTION_HEADINGS = [
  "experience",
  "work experience",
  "employment",
  "professional experience",
  "education",
  "skills",
  "projects",
  "summary",
  "profile",
  "certifications",
  "publications",
];

const ACTION_VERBS = new Set([
  "accelerated", "achieved", "analyzed", "analysed", "architected", "automated",
  "built", "coached", "collaborated", "conceptualized", "consolidated",
  "coordinated", "created", "cut", "debugged", "decreased", "delivered",
  "designed", "developed", "directed", "doubled", "drove", "enabled",
  "engineered", "established", "executed", "expanded", "founded", "generated",
  "grew", "headed", "implemented", "improved", "increased", "initiated",
  "introduced", "launched", "led", "maintained", "managed", "mentored",
  "migrated", "modernized", "modernised", "negotiated", "optimized",
  "optimised", "orchestrated", "owned", "pioneered", "produced", "prototyped",
  "reduced", "refactored", "researched", "resolved", "scaled", "shaped",
  "shipped", "simplified", "spearheaded", "streamlined", "strengthened",
  "transformed", "tripled", "wrote",
]);

// Quantifiers are bounded on purpose: resume text is untrusted, and an
// unbounded ambiguous quantifier is a quadratic ReDoS (CodeQL
// js/polynomial-redos). Bounds stay generous — real emails/phones/numbers
// never reach them.
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.]{1,24}/;
const PHONE_RE = /\+?\d[\d\s().-]{7,20}\d/;
const URL_RE = /(https?:\/\/|www\.|linkedin\.com|github\.com)/i;
const BULLET_RE = /^\s*(?:[-*•‣◦]|\d+\.)\s*/;
const NUMBER_RE = /[$€£]?\d[\d,]{0,15}(?:\.\d+)?\s{0,4}(?:%|percent|x|k|m|b)?\b/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const MONTH_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]{0,9}\.?\s{0,2}['’]?\d{2,4}\b/i;
const PRESENT_RE = /\b(present|current|ongoing)\b/i;
const FIRST_PERSON_RE = /\b(i|me|my|mine|myself|we|our|us)\b/gi;

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}



function firstWord(line: string): string {
  return (
    line
      .replace(BULLET_RE, "")
      .trim()
      .match(/[\p{L}]+/u)?.[0] ?? ""
  ).toLowerCase();
}

/** All keywords of a skill node plus its descendants (a child counts toward its parent). */
function keywordsFor(skillId: string): string[] {
  const visited = new Set<string>();
  const keywords = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const kw of taxonomy.getNode(id as never)?.keywords ?? [])
      keywords.add(kw);
    for (const child of taxonomy.childrenOf(id as never)) visit(child);
  };
  visit(skillId);
  return [...keywords];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordInLine(keyword: string, line: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(keyword)}([^a-z0-9]|$)`, "i").test(
    line,
  );
}

/**
 * §9.5 deterministic ATS check. `requirements` are the target role's
 * requirements; required ones drive keyword coverage.
 */
export function atsCheck(resumeText: string, requirements: Requirement[]): AtsResult {
  const lines = resumeText.split(/\r?\n/);
  const words = countWords(resumeText);
  const bullets = bulletLines(resumeText);
  const checks: AtsCheck[] = [];

  // --- contact info -------------------------------------------------------
  const contact = {
    email: EMAIL_RE.test(resumeText),
    phone: PHONE_RE.test(resumeText),
    url: URL_RE.test(resumeText),
  };
  const contactFound = Object.values(contact).filter(Boolean).length;
  checks.push({
    id: "contact",
    label: "Contact information",
    weight: 2,
    status: contactFound >= 2 ? "pass" : contactFound === 1 ? "warn" : "fail",
    detail:
      contactFound >= 2
        ? "Email/phone/link found — recruiters and ATS parsers can reach you."
        : contactFound === 1
          ? `Only ${contact.email ? "an email" : contact.phone ? "a phone number" : "a link"} found — add a phone/email and a LinkedIn or portfolio link.`
          : "No email, phone number, or link found — ATS systems cannot contact you.",
  });

  // --- section headings ----------------------------------------------------
  const norm = resumeText.toLowerCase();
  const headingsFound = SECTION_HEADINGS.filter((h) =>
    new RegExp(`(^|\\n)\\s*#*\\s*${escapeRe(h)}\\b`, "i").test(norm),
  );
  checks.push({
    id: "headings",
    label: "Section headings",
    weight: 2,
    status:
      headingsFound.length >= 3 ? "pass" : headingsFound.length >= 1 ? "warn" : "fail",
    detail:
      headingsFound.length >= 3
        ? `Found ${headingsFound.length} standard sections (${headingsFound.slice(0, 4).join(", ")}…).`
        : headingsFound.length > 0
          ? `Only "${headingsFound[0]}" found — add standard headings like Experience, Skills, Education.`
          : "No standard headings found — ATS parsers look for Experience, Skills, Education.",
  });

  // --- length ---------------------------------------------------------------
  checks.push({
    id: "length",
    label: "Length",
    weight: 1,
    status:
      words >= 300 && words <= 900
        ? "pass"
        : (words >= 150 && words < 300) || (words > 900 && words <= 1200)
          ? "warn"
          : "fail",
    detail:
      words >= 300 && words <= 900
        ? `${words} words — inside the 300–900 word sweet spot.`
        : `${words} words — aim for 300–900 words.`,
  });

  // --- bullet count ----------------------------------------------------------
  checks.push({
    id: "bullets",
    label: "Bullet points",
    weight: 1,
    status: bullets.length >= 6 ? "pass" : bullets.length >= 3 ? "warn" : "fail",
    detail:
      bullets.length >= 6
        ? `${bullets.length} bullets — easy to scan.`
        : bullets.length > 0
          ? `${bullets.length} bullets — aim for at least 6 scannable bullets.`
          : "No bullet points found — dense paragraphs get skipped.",
  });

  // --- quantified bullets -----------------------------------------------------
  const quantified = bullets.filter((b) => NUMBER_RE.test(b)).length;
  const ratio = bullets.length > 0 ? quantified / bullets.length : 0;
  checks.push({
    id: "quantified",
    label: "Quantified impact",
    weight: 2,
    status:
      bullets.length === 0
        ? "fail"
        : ratio >= 0.3
          ? "pass"
          : ratio >= 0.15
            ? "warn"
            : "fail",
    detail:
      bullets.length === 0
        ? "No bullets to quantify — add outcomes with numbers."
        : `${quantified} of ${bullets.length} bullets include a number (${Math.round(ratio * 100)}%) — aim for ≥30%.`,
  });

  // --- action-verb starts ------------------------------------------------------
  const verbStarts = bullets.filter((b) => ACTION_VERBS.has(firstWord(b))).length;
  const verbRatio = bullets.length > 0 ? verbStarts / bullets.length : 0;
  checks.push({
    id: "action_verbs",
    label: "Action-verb starts",
    weight: 1,
    status:
      bullets.length === 0
        ? "fail"
        : verbRatio >= 0.5
          ? "pass"
          : verbRatio >= 0.3
            ? "warn"
            : "fail",
    detail:
      bullets.length === 0
        ? "No bullets found — start achievements with verbs like Led, Built, Reduced."
        : `${verbStarts} of ${bullets.length} bullets start with an action verb (${Math.round(verbRatio * 100)}%) — aim for ≥50%.`,
  });

  // --- first-person pronouns ----------------------------------------------------
  const pronouns = (resumeText.match(FIRST_PERSON_RE) ?? []).length;
  checks.push({
    id: "first_person",
    label: "First-person pronouns",
    weight: 1,
    status: pronouns <= 2 ? "pass" : pronouns <= 6 ? "warn" : "fail",
    detail:
      pronouns <= 2
        ? "No (or almost no) first-person pronouns — correct resume style."
        : `${pronouns} first-person pronouns (I/my/we) — drop them; the implied subject is you.`,
  });

  // --- dates ---------------------------------------------------------------------
  const dateHits =
    (resumeText.match(new RegExp(YEAR_RE.source, "g")) ?? []).length +
    (resumeText.match(new RegExp(MONTH_RE.source, "gi")) ?? []).length +
    (PRESENT_RE.test(resumeText) ? 1 : 0);
  checks.push({
    id: "dates",
    label: "Dates",
    weight: 1,
    status: dateHits >= 3 ? "pass" : dateHits >= 1 ? "warn" : "fail",
    detail:
      dateHits >= 3
        ? "Dates found for your roles/education."
        : dateHits > 0
          ? "Few dates found — add a date range (e.g. 2021–Present) to every role."
          : "No dates found — every role needs a date range like 2021–Present.",
  });

  // --- required-skill keyword coverage ---------------------------------------------
  const required = requirements.filter((r) => r.kind === "required");
  const present: AtsKeywordCoverage["present"] = [];
  const missing: AtsKeywordCoverage["missing"] = [];
  for (const req of required) {
    const keywords = keywordsFor(req.skillId);
    const line = lines.find((l) => keywords.some((k) => keywordInLine(k, l)));
    const label = req.label || taxonomy.labelFor(req.skillId);
    if (line) {
      present.push({ skillId: req.skillId, label, snippet: line.trim() });
    } else {
      missing.push({ skillId: req.skillId, label });
    }
  }
  const coverage =
    required.length === 0 ? 1 : present.length / required.length;
  checks.push({
    id: "keywords",
    label: "Required-skill keywords",
    weight: 3,
    status:
      required.length === 0
        ? "pass"
        : coverage >= 0.7
          ? "pass"
          : coverage >= 0.4
            ? "warn"
            : "fail",
    detail:
      required.length === 0
        ? "The target role lists no required skills."
        : `${present.length} of ${required.length} required skills appear in the resume (${Math.round(coverage * 100)}%) — aim for ≥70%.`,
  });

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const score = Math.round(
    (100 *
      checks.reduce(
        (s, c) => s + c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0),
        0,
      )) /
      totalWeight,
  );

  return { score, checks, keywordCoverage: { present, missing } };
}
