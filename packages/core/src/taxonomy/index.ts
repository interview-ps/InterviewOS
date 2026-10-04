import type { SkillId } from "../skill-id.js";
import { humanizeSkillSegment, isSkillId, parentSkillId } from "../skill-id.js";
import { TAXONOMY_SEED, type TaxonomyNodeSeed } from "./seed.js";

export interface TaxonomyNode {
  id: SkillId;
  label: string;
  keywords: string[];
}

const nodes = new Map<SkillId, TaxonomyNode>();
const childrenIndex = new Map<SkillId, Set<SkillId>>();

function register(node: TaxonomyNode): void {
  nodes.set(node.id, node);
  const parent = parentSkillId(node.id);
  if (parent) {
    const set = childrenIndex.get(parent) ?? new Set<SkillId>();
    set.add(node.id);
    childrenIndex.set(parent, set);
    if (!nodes.has(parent)) ensureNode(parent);
  }
}

function ensureNode(id: SkillId): TaxonomyNode {
  const existing = nodes.get(id);
  if (existing) return existing;
  const last = id.split(".").pop()!;
  const created: TaxonomyNode = { id, label: humanizeSkillSegment(last), keywords: [] };
  register(created);
  return created;
}

const seededIds = new Set<SkillId>();
for (const seed of TAXONOMY_SEED as TaxonomyNodeSeed[]) {
  register({ id: seed.id, label: seed.label, keywords: seed.keywords });
  seededIds.add(seed.id);
}

const EXTRA_ALIASES: Record<string, SkillId> = {
  "rest-api": "apis.rest",
  restapi: "apis.rest",
  "message-queue": "distributed-systems.message-queues",
  "message-queues": "distributed-systems.message-queues",
  mq: "distributed-systems.message-queues",
  "cache-invalidation": "distributed-systems.caching.cache-invalidation",
  "cache-strategy": "distributed-systems.caching.cache-strategies",
  "system-design.requirements": "system-design.requirements-analysis",
  "cap-theorem": "distributed-systems.consistency",
};

let aliasIndex: Map<string, SkillId> | null = null;

function normalizeRaw(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

function getAliasIndex(): Map<string, SkillId> {
  if (aliasIndex) return aliasIndex;
  aliasIndex = new Map();
  for (const node of nodes.values()) {
    for (const key of [node.id, node.label, ...node.keywords]) {
      const normalized = normalizeRaw(key);
      if (isSkillId(normalized) && !aliasIndex.has(normalized)) {
        aliasIndex.set(normalized, node.id);
      }
    }
  }
  for (const [alias, id] of Object.entries(EXTRA_ALIASES)) {
    aliasIndex.set(alias, id);
  }
  return aliasIndex;
}

/** Returns the node for `id`, creating an on-demand node for valid unknown ids. */
export function getNode(id: string): TaxonomyNode | undefined {
  if (!isSkillId(id)) return undefined;
  return ensureNode(id);
}

export function hasNode(id: string): boolean {
  return nodes.has(id as SkillId);
}

export function parentOf(id: SkillId): SkillId | null {
  return parentSkillId(id);
}

/** Ancestors of `id` from immediate parent up to the root. */
export function ancestors(id: SkillId): SkillId[] {
  const out: SkillId[] = [];
  let cur = parentSkillId(id);
  while (cur) {
    out.push(cur);
    cur = parentSkillId(cur);
  }
  return out;
}

export function childrenOf(id: SkillId): SkillId[] {
  return [...(childrenIndex.get(id) ?? [])].sort();
}

/**
 * §9.1: cross-branch "related" edges — symmetric by construction. A skill weak
 * in one round pulls its related skills into scope for later rounds (§9.2).
 */
export const RELATED_EDGES: ReadonlyArray<readonly [SkillId, SkillId]> = [
  ["sql.transactions", "distributed-systems.consistency"],
  ["sql.transactions", "system-design.data-modeling"],
  [
    "distributed-systems.caching.cache-invalidation",
    "distributed-systems.consistency",
  ],
  ["distributed-systems.message-queues", "system-design.async-processing"],
  ["coding.complexity", "system-design.scalability"],
];

const relatedIndex = new Map<SkillId, Set<SkillId>>();
for (const [a, b] of RELATED_EDGES) {
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    const set = relatedIndex.get(x) ?? new Set<SkillId>();
    set.add(y);
    relatedIndex.set(x, set);
  }
}

/** Skills related to `id` via §9.1 cross-branch edges (both directions). */
export function relatedTo(id: SkillId): SkillId[] {
  return [...(relatedIndex.get(id) ?? [])].sort();
}

export function labelFor(id: SkillId): string {
  const node = nodes.get(id);
  if (node) return node.label;
  const last = id.split(".").pop()!;
  return humanizeSkillSegment(last);
}

export function allNodes(): TaxonomyNode[] {
  return [...nodes.values()];
}

/**
 * v0.4 packs: register extra taxonomy nodes (idempotent — same id just
 * overwrites). Invalidates the alias index so new keywords resolve.
 */
export function registerNodes(
  list: ReadonlyArray<{ id: SkillId; label: string; keywords?: string[] }>,
): void {
  for (const n of list) {
    register({ id: n.id, label: n.label, keywords: n.keywords ?? [] });
  }
  aliasIndex = null;
}

function countKeywordMentions(text: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "gi");
  return (text.match(re) ?? []).length;
}

export interface SkillMatch {
  skillId: SkillId;
  mentions: number;
}

/** Case-insensitive, word-boundary keyword matching over the taxonomy. */
export function matchSkills(text: string): SkillMatch[] {
  const results: SkillMatch[] = [];
  for (const node of nodes.values()) {
    let mentions = 0;
    for (const keyword of node.keywords) {
      mentions += countKeywordMentions(text, keyword);
    }
    if (mentions > 0) results.push({ skillId: node.id, mentions });
  }
  return results.sort((a, b) => b.mentions - a.mentions || a.skillId.localeCompare(b.skillId));
}

/**
 * Lowercase, spaces/underscores → '-', collapse dashes, map known aliases.
 * Returns null when the result is not a valid SkillId.
 */
export function normalizeSkillId(raw: string): SkillId | null {
  const normalized = normalizeRaw(raw);
  const alias = getAliasIndex().get(normalized);
  if (alias) return alias;
  if (!isSkillId(normalized)) return null;
  if (seededIds.has(normalized)) return normalized;
  // models sometimes guess a branch prefix ("coding.complexity-analysis");
  // snap the last segment to a canonical node when it is a known alias
  const last = normalized.split(".").pop()!;
  if (last !== normalized) {
    const lastAlias = getAliasIndex().get(last);
    if (lastAlias) return lastAlias;
  }
  return normalized;
}
