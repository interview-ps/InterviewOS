import type { SkillId } from "../skill-id.js";
import { parentSkillId } from "../skill-id.js";
import type { Requirement } from "../target/index.js";
import * as defaultTaxonomy from "../taxonomy/index.js";
import type { Evidence, EvidenceType, ReadinessGraph, SkillReadiness } from "./schema.js";

export * from "./schema.js";

export const EVIDENCE_TYPE_WEIGHT: Record<EvidenceType, number> = {
  interview_answer: 1.0,
  practice: 0.7,
  resume_claim: 0.4,
  self_report: 0.3,
};

/** Half-life in days per evidence type (§8.1 time decay). */
export const EVIDENCE_HALF_LIFE_DAYS: Record<EvidenceType, number> = {
  interview_answer: 60,
  practice: 45,
  self_report: 30,
  resume_claim: 180,
};

export const RECENCY_DECAY = 0.85;
const DAY_MS = 86_400_000;
const CONFIDENCE_SATURATION = 1.5;
const CONFIDENCE_CAP = 0.95;
const UNKNOWN_PRIOR = 0.25;

export interface TaxonomyLike {
  parentOf(id: SkillId): SkillId | null;
  labelFor(id: SkillId): string;
  childrenOf(id: SkillId): SkillId[];
}

export interface DirectReadiness {
  score: number | null;
  confidence: number;
  weight: number;
  evidenceIds: string[];
  status: SkillReadiness["status"];
}

export function statusForScore(score: number | null): SkillReadiness["status"] {
  if (score === null) return "unknown";
  if (score < 0.5) return "weak";
  if (score < 0.75) return "developing";
  return "strong";
}

function sortNewestFirst(evidence: Evidence[]): Evidence[] {
  return [...evidence].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

function evidenceWeight(e: Evidence, rank: number, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(e.createdAt)) / DAY_MS);
  const ageDecay = Math.pow(0.5, ageDays / EVIDENCE_HALF_LIFE_DAYS[e.type]);
  return (
    e.confidence * EVIDENCE_TYPE_WEIGHT[e.type] * Math.pow(RECENCY_DECAY, rank) * ageDecay
  );
}

export function confidenceForWeight(totalWeight: number): number {
  return Math.min(CONFIDENCE_CAP, 1 - Math.exp(-totalWeight / CONFIDENCE_SATURATION));
}

export function computeSkillReadiness(
  evidence: Evidence[],
  now: Date = new Date(),
): DirectReadiness {
  const sorted = sortNewestFirst(evidence);
  let weight = 0;
  let weightedScore = 0;
  sorted.forEach((e, rank) => {
    const w = evidenceWeight(e, rank, now);
    weight += w;
    weightedScore += w * e.score;
  });
  const score = weight === 0 ? null : weightedScore / weight;
  return {
    score,
    confidence: weight === 0 ? 0 : confidenceForWeight(weight),
    weight,
    evidenceIds: sorted.map((e) => e.id),
    status: statusForScore(score),
  };
}

export interface BuildReadinessGraphInput {
  evidence: Evidence[];
  requirements: Requirement[];
  taxonomy?: TaxonomyLike;
  now?: Date;
}

export function buildReadinessGraph(input: BuildReadinessGraphInput): ReadinessGraph {
  const taxonomy = input.taxonomy ?? defaultTaxonomy;
  const now = input.now ?? new Date();
  const evidenceBySkill = new Map<SkillId, Evidence[]>();
  for (const e of input.evidence) {
    const list = evidenceBySkill.get(e.skillId) ?? [];
    list.push(e);
    evidenceBySkill.set(e.skillId, list);
  }

  const nodeIds = new Set<SkillId>();
  const addWithAncestors = (id: SkillId) => {
    let cur: SkillId | null = id;
    while (cur && !nodeIds.has(cur)) {
      nodeIds.add(cur);
      cur = parentSkillId(cur);
    }
  };
  for (const r of input.requirements) addWithAncestors(r.skillId);
  for (const e of input.evidence) addWithAncestors(e.skillId);

  const childrenOfNode = new Map<SkillId, SkillId[]>();
  for (const id of nodeIds) {
    const parent = parentSkillId(id);
    if (parent && nodeIds.has(parent)) {
      const list = childrenOfNode.get(parent) ?? [];
      list.push(id);
      childrenOfNode.set(parent, list);
    }
  }
  for (const list of childrenOfNode.values()) list.sort();

  const depth = (id: SkillId) => id.split(".").length - 1;
  const ordered = [...nodeIds].sort(
    (a, b) => depth(b) - depth(a) || a.localeCompare(b),
  );

  const dimensions: Record<string, SkillReadiness> = {};
  for (const id of ordered) {
    const direct = computeSkillReadiness(evidenceBySkill.get(id) ?? [], now);
    const children = childrenOfNode.get(id) ?? [];
    const scoredChildren = children
      .map((c) => dimensions[c])
      .filter((c): c is SkillReadiness => c !== undefined && c.score !== null);

    let score = direct.score;
    let confidence = direct.confidence;
    if (scoredChildren.length > 0) {
      const childConfSum = scoredChildren.reduce((s, c) => s + c.confidence, 0);
      const childScore =
        scoredChildren.reduce((s, c) => s + c.score! * c.confidence, 0) / childConfSum;
      const childWeight = childConfSum / scoredChildren.length;
      const totalWeight = direct.weight + childWeight;
      score =
        (direct.weight * (direct.score ?? 0) + childScore * childWeight) / totalWeight;
      confidence = confidenceForWeight(totalWeight);
    }

    dimensions[id] = {
      skillId: id,
      label: taxonomy.labelFor(id),
      score,
      confidence,
      evidenceIds: direct.evidenceIds,
      children,
      status: statusForScore(score),
    };
  }

  let importanceSum = 0;
  let overallNum = 0;
  let overallConfNum = 0;
  for (const req of input.requirements) {
    const dim = dimensions[req.skillId];
    importanceSum += req.importance;
    overallNum += req.importance * (dim?.score ?? UNKNOWN_PRIOR);
    overallConfNum += req.importance * (dim?.confidence ?? 0);
  }

  return {
    dimensions,
    overall: importanceSum === 0 ? 0 : overallNum / importanceSum,
    overallConfidence: importanceSum === 0 ? 0 : overallConfNum / importanceSum,
    lastUpdated: now.toISOString(),
  };
}
