import type { SkillId } from "../skill-id.js";
import { parentSkillId } from "../skill-id.js";
import type { Requirement } from "../target/index.js";
import type { Level } from "../target/index.js";
import type { Evidence, SkillReadiness } from "../readiness/schema.js";
import { relatedTo, labelFor } from "../taxonomy/index.js";
import { inRound, roundFallbackRequirements, type RoundType } from "./rounds.js";
import type { QuestionDifficulty } from "./index.js";

/** A skill flagged weak in an earlier round of the current interview loop. */
export interface LoopWeakSkill {
  skillId: SkillId;
  /** 1-based loop round the weakness came from. */
  round: number;
  /** The mode of that round (for the human-readable reason). */
  mode: RoundType;
}

export interface SelectNextSkillInput {
  requirements: Requirement[];
  readiness: Record<SkillId, SkillReadiness>;
  evidence: Evidence[];
  askedThisSession: SkillId[];
  askedPreviousSession: SkillId[];
  /** 0-based index of the question about to be asked in this session. */
  questionIndex: number;
  /** Interview round type/mode; "mixed" (default) keeps the whole pool. */
  roundType?: RoundType;
  /** §9.2: same as roundType — the interview mode selecting within its scope. */
  mode?: RoundType;
  /** Target level — drives question difficulty. */
  level?: Level;
  /** Times each skill has been asked across ALL sessions (novelty factor). */
  askCounts?: Record<SkillId, number>;
  /** Weak skills carried over from earlier rounds of a loop (§9.2, W2 feeds). */
  loopWeakSkills?: LoopWeakSkill[];
  /** v0.4: interview-pack focus skills — boost candidates that descend from them. */
  focusSkills?: SkillId[];
}

export interface SelectionFactors {
  roleImportance: number;
  readinessGap: number;
  uncertainty: number;
  weaknessBoost: number;
  recencyFactor: number;
  noveltyFactor: number;
  /** v0.4: +0.15 when the candidate skill equals/descends from a pack focus skill. */
  packFocus?: number;
}

export interface SkillCandidate {
  skillId: SkillId;
  priority: number;
  reason: string;
  factors: SelectionFactors;
}

export interface SelectNextSkillResult {
  skillId: SkillId;
  priority: number;
  reason: string;
  difficulty: QuestionDifficulty;
  factors: SelectionFactors;
  candidates: SkillCandidate[];
}

const LOW_CONFIDENCE = 0.5;
const CONFIRMATION_CONFIDENCE_CAP = 0.8;
const WEAK_INTERVIEW_SCORE = 0.5;
const FALLBACK_IMPORTANCE = 0.5;
const NOVELTY_ASK_CAP = 3;
const MODE_LABELS: Record<RoundType, string> = {
  mixed: "Mixed",
  technical: "Technical",
  coding: "Coding",
  system_design: "System design",
  behavioral: "Behavioral",
  hiring_manager: "Hiring manager",
  hr: "HR",
};

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

/** §9.2 difficulty: base by level, +1 step when strong (≥0.75), −1 when weak (<0.4). */
export function difficultyFor(level: Level, score: number | null): QuestionDifficulty {
  const steps: QuestionDifficulty[] = ["easy", "medium", "hard"];
  let idx = level === "junior" ? 0 : level === "staff" ? 2 : 1;
  if (score !== null && score >= 0.75) idx += 1;
  else if (score !== null && score < 0.4) idx -= 1;
  return steps[Math.max(0, Math.min(steps.length - 1, idx))]!;
}

interface FactorResult {
  factors: SelectionFactors;
  weak: boolean;
  loopTrigger: { weakSkillId: SkillId; round: number; mode: RoundType; direct: boolean } | null;
  reasonDetail: string;
}

function computeFactors(
  skillId: SkillId,
  dim: SkillReadiness | undefined,
  req: Requirement | undefined,
  evidenceBySkill: Map<SkillId, Evidence[]>,
  askedHere: Set<SkillId>,
  askedBefore: Set<SkillId>,
  askCounts: Record<SkillId, number>,
  loopWeakSkills: LoopWeakSkill[],
  focusSkills: SkillId[],
): FactorResult {
  const roleImportance = req?.importance ?? FALLBACK_IMPORTANCE;
  const readinessGap = 1 - (dim?.score ?? 0);
  const uncertainty = 1 - (dim?.confidence ?? 0);

  const weak = (evidenceBySkill.get(skillId) ?? []).some(
    (e) => e.type === "interview_answer" && e.score < WEAK_INTERVIEW_SCORE,
  );
  const direct = loopWeakSkills.find((s) => s.skillId === skillId);
  const viaRelated = loopWeakSkills.find((s) => relatedTo(s.skillId).includes(skillId));
  const loopTrigger = direct
    ? { weakSkillId: skillId, round: direct.round, mode: direct.mode, direct: true }
    : viaRelated
      ? { weakSkillId: viaRelated.skillId, round: viaRelated.round, mode: viaRelated.mode, direct: false }
      : null;

  let recencyFactor = 1.0;
  let weaknessBoost = 1.0;
  let reasonDetail = "not previously asked";
  if (askedHere.has(skillId)) {
    // asked this session: recency dominates and cancels the weakness boost
    recencyFactor = 0.15;
    reasonDetail = "already asked this session";
  } else {
    if (weak) {
      weaknessBoost = 1.6;
      reasonDetail = "weak interview evidence; retesting";
    } else if (loopTrigger) {
      weaknessBoost = 1.4;
      reasonDetail = "weak in an earlier loop round";
    }
    if (askedBefore.has(skillId) && !weak) {
      recencyFactor = 0.6;
      reasonDetail = "asked in a previous session";
    }
  }
  const askedAll = askCounts[skillId] ?? 0;
  const noveltyFactor = askedAll >= NOVELTY_ASK_CAP && !weak ? 0.85 : 1.0;
  const packFocus =
    focusSkills.length > 0 &&
    focusSkills.some((f) => skillId === f || skillId.startsWith(`${f}.`))
      ? 0.15
      : 0;

  return {
    factors: {
      roleImportance,
      readinessGap,
      uncertainty,
      weaknessBoost,
      recencyFactor,
      noveltyFactor,
      packFocus,
    },
    weak,
    loopTrigger,
    reasonDetail,
  };
}

function priorityOf(f: SelectionFactors): number {
  return (
    f.roleImportance *
    Math.max(f.readinessGap, 0.1) *
    (0.5 + f.uncertainty) *
    f.weaknessBoost *
    f.recencyFactor *
    f.noveltyFactor *
    (1 + (f.packFocus ?? 0))
  );
}

export function selectNextSkill(input: SelectNextSkillInput): SelectNextSkillResult | null {
  const {
    requirements,
    readiness,
    evidence,
    askedThisSession,
    askedPreviousSession,
    questionIndex,
    level = "mid",
    askCounts = {},
    loopWeakSkills = [],
    focusSkills = [],
  } = input;
  const mode = input.mode ?? input.roundType ?? "mixed";
  const inScope = (skillId: SkillId) => inRound(skillId, mode);
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

  const resultFor = (
    skillId: SkillId,
    dim: SkillReadiness | undefined,
    priority: number,
    reason: string,
    factors: SelectionFactors,
    candidates: SkillCandidate[],
  ): SelectNextSkillResult => ({
    skillId,
    priority,
    reason,
    difficulty: difficultyFor(level, dim?.score ?? null),
    factors,
    candidates,
  });

  // Every 4th question of a session confirms a strong area (highest score, confidence < 0.8).
  if ((questionIndex + 1) % 4 === 0) {
    const confirmable = Object.values(scopedReadiness)
      .filter((r) => r.score !== null && r.confidence < CONFIRMATION_CONFIDENCE_CAP)
      .sort((a, b) => (b.score! - a.score!) || a.skillId.localeCompare(b.skillId));
    const top = confirmable[0];
    if (top) {
      const factors: SelectionFactors = {
        roleImportance: nearestRequirement(top.skillId, reqMap)?.importance ?? FALLBACK_IMPORTANCE,
        readinessGap: 1 - (top.score ?? 0),
        uncertainty: 1 - top.confidence,
        weaknessBoost: 1,
        recencyFactor: 1,
        noveltyFactor: 1,
        packFocus:
          focusSkills.length > 0 &&
          focusSkills.some((f) => top.skillId === f || top.skillId.startsWith(`${f}.`))
            ? 0.15
            : 0,
      };
      return resultFor(
        top.skillId,
        top,
        top.score!,
        "every-4th-question strong-area confirmation",
        factors,
        confirmable.map((r) => ({
          skillId: r.skillId,
          priority: r.score!,
          reason: "confirmation candidate",
          factors: {
            ...factors,
            readinessGap: 1 - (r.score ?? 0),
            uncertainty: 1 - r.confidence,
          },
        })),
      );
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

  // §9.2: in-scope loop-weak skills and their in-scope related skills join the pool
  for (const weak of loopWeakSkills) {
    if (inScope(weak.skillId)) pool.add(weak.skillId);
    for (const rel of relatedTo(weak.skillId)) {
      if (inScope(rel)) pool.add(rel);
    }
  }

  // Empty pool in a focused mode → the mode's fallback taxonomy nodes join at 0.6.
  if (pool.size === 0 && mode !== "mixed") {
    for (const req of roundFallbackRequirements(mode)) {
      reqMap.set(req.skillId, req);
      pool.add(req.skillId);
    }
  }

  const candidates: SkillCandidate[] = [...pool].map((skillId) => {
    const dim = readiness[skillId];
    const req = nearestRequirement(skillId, reqMap);
    const fr = computeFactors(
      skillId,
      dim,
      req,
      evidenceBySkill,
      askedHere,
      askedBefore,
      askCounts,
      loopWeakSkills,
      focusSkills,
    );
    const priority = priorityOf(fr.factors);
    const base =
      dim?.score === null || dim === undefined
        ? "no evidence yet"
        : `readiness ${dim.score!.toFixed(2)}`;
    const reason = fr.loopTrigger
      ? `Round ${fr.loopTrigger.round} (${MODE_LABELS[fr.loopTrigger.mode]}) showed weak ${labelFor(fr.loopTrigger.weakSkillId)} → ${
          fr.loopTrigger.direct ? "retesting it" : `testing ${labelFor(skillId)}`
        }`
      : `${base}; ${fr.reasonDetail}`;
    return { skillId, priority, reason, factors: fr.factors };
  });

  candidates.sort((a, b) => b.priority - a.priority || a.skillId.localeCompare(b.skillId));
  const top = candidates[0];
  if (!top) return null;
  return resultFor(top.skillId, readiness[top.skillId], top.priority, top.reason, top.factors, candidates);
}
