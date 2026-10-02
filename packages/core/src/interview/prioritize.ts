import type { SkillId } from "../skill-id.js";
import { parentSkillId } from "../skill-id.js";
import type { Requirement } from "../target/index.js";
import type { Evidence, SkillReadiness } from "../readiness/schema.js";
import { inRound, roundFallbackRequirements, type RoundType } from "./rounds.js";

export interface SelectNextSkillInput {
  requirements: Requirement[];
  readiness: Record<SkillId, SkillReadiness>;
  evidence: Evidence[];
  askedThisSession: SkillId[];
  askedPreviousSession: SkillId[];
  /** 0-based index of the question about to be asked in this session. */
  questionIndex: number;
  /** Interview round type; "mixed" (default) keeps the whole pool. */
  roundType?: RoundType;
}

export interface SkillCandidate {
  skillId: SkillId;
  priority: number;
  reason: string;
}

export interface SelectNextSkillResult {
  skillId: SkillId;
  priority: number;
  reason: string;
  candidates: SkillCandidate[];
}

const LOW_CONFIDENCE = 0.5;
const CONFIRMATION_CONFIDENCE_CAP = 0.8;
const WEAK_INTERVIEW_SCORE = 0.5;
const FALLBACK_IMPORTANCE = 0.5;

function nearestRequirement(
  skillId: SkillId,
  requirements: Map<SkillId, Requirement>,
): Requirement | undefined {
  let cur: SkillId | null = skillId;
  while (cur !== null) {
    const hit = requirements.get(cur);
    if (hit) return hit;
    cur = parentSkillId(cur);
  }
  return undefined;
}

function recencyAdjustment(
  skillId: SkillId,
  evidenceBySkill: Map<SkillId, Evidence[]>,
  askedThisSession: Set<SkillId>,
  askedPreviousSession: Set<SkillId>,
): { factor: number; reason: string } {
  if (askedThisSession.has(skillId)) {
    return { factor: 0.15, reason: "already asked this session" };
  }
  const weak = (evidenceBySkill.get(skillId) ?? []).some(
    (e) => e.type === "interview_answer" && e.score < WEAK_INTERVIEW_SCORE,
  );
  if (weak) {
    return { factor: 1.6, reason: "weak interview evidence; retesting" };
  }
  if (askedPreviousSession.has(skillId)) {
    return { factor: 0.6, reason: "asked in a previous session" };
  }
  return { factor: 1.0, reason: "not previously asked" };
}

export function selectNextSkill(input: SelectNextSkillInput): SelectNextSkillResult | null {
  const {
    requirements,
    readiness,
    evidence,
    askedThisSession,
    askedPreviousSession,
    questionIndex,
    roundType = "mixed",
  } = input;
  // §8.4 round filter: requirements and readiness dims outside the round drop out
  const inScope = (skillId: SkillId) => inRound(skillId, roundType);
  const requirements0 = requirements.filter((r) => inScope(r.skillId));
  const scopedReadiness = Object.fromEntries(
    Object.entries(readiness).filter(([id]) => inScope(id as SkillId)),
  ) as Record<SkillId, SkillReadiness>;
  const reqMap = new Map<SkillId, Requirement>(requirements0.map((r) => [r.skillId, r]));
  const askedHere = new Set(askedThisSession);
  const askedBefore = new Set(askedPreviousSession);
  const evidenceBySkill = new Map<SkillId, Evidence[]>();
  for (const e of evidence) {
    const list = evidenceBySkill.get(e.skillId) ?? [];
    list.push(e);
    evidenceBySkill.set(e.skillId, list);
  }

  // Every 4th question of a session confirms a strong area (highest score, confidence < 0.8).
  if ((questionIndex + 1) % 4 === 0) {
    const confirmable = Object.values(scopedReadiness)
      .filter((r) => r.score !== null && r.confidence < CONFIRMATION_CONFIDENCE_CAP)
      .sort((a, b) => (b.score! - a.score!) || a.skillId.localeCompare(b.skillId));
    const top = confirmable[0];
    if (top) {
      return {
        skillId: top.skillId,
        priority: top.score!,
        reason: "every-4th-question strong-area confirmation",
        candidates: confirmable.map((r) => ({
          skillId: r.skillId,
          priority: r.score!,
          reason: "confirmation candidate",
        })),
      };
    }
  }

  const pool = new Set<SkillId>();
  for (const r of requirements0) pool.add(r.skillId);
  for (const [skillId, dim] of Object.entries(scopedReadiness)) {
    const hasEvidence = dim.evidenceIds.length > 0 || dim.score !== null;
    const nearestReq = nearestRequirement(skillId, reqMap);
    if (hasEvidence && nearestReq && nearestReq.skillId !== skillId) {
      pool.add(skillId); // taxonomy descendant of a requirement, with evidence
    }
    if (dim.status !== "unknown" && dim.confidence < LOW_CONFIDENCE) {
      pool.add(skillId); // low-confidence skill
    }
  }

  // Empty pool in a focused round → the round's taxonomy nodes join at 0.6.
  if (pool.size === 0 && roundType !== "mixed") {
    for (const req of roundFallbackRequirements(roundType)) {
      reqMap.set(req.skillId, req);
      pool.add(req.skillId);
    }
  }

  const candidates: SkillCandidate[] = [...pool].map((skillId) => {
    const dim = readiness[skillId];
    const req = nearestRequirement(skillId, reqMap);
    const roleImportance = req?.importance ?? FALLBACK_IMPORTANCE;
    const readinessGap = 1 - (dim?.score ?? 0);
    const uncertainty = 1 - (dim?.confidence ?? 0);
    const recency = recencyAdjustment(skillId, evidenceBySkill, askedHere, askedBefore);
    const priority =
      roleImportance * Math.max(readinessGap, 0.1) * (0.5 + uncertainty) * recency.factor;
    const base =
      dim?.score === null || dim === undefined
        ? "no evidence yet"
        : `readiness ${dim.score!.toFixed(2)}`;
    return {
      skillId,
      priority,
      reason: `${base}; ${recency.reason}`,
    };
  });

  candidates.sort((a, b) => b.priority - a.priority || a.skillId.localeCompare(b.skillId));
  const top = candidates[0];
  if (!top) return null;
  return { skillId: top.skillId, priority: top.priority, reason: top.reason, candidates };
}
