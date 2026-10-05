/**
 * Golden cases for packages/core/src/taxonomy/index.ts (default seed only —
 * registerNodes is never called).
 *
 * ORDER MATTERS in this file: `getNode` creates on-demand nodes for
 * unknown-but-valid skill ids, mutating the module-level registry for the
 * rest of the process. `allNodes` must run first and every `getNode` case on
 * a made-up id comes last.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AreaCases } from "./helpers.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const BACKEND_ENGINEER_JD = fs.readFileSync(
  path.join(REPO_ROOT, "examples", "backend-engineer", "job.md"),
  "utf8",
);

export const taxonomyCases: AreaCases = {
  area: "taxonomy",
  cases: [
    // Snapshot of the seeded registry — must run before getNode creates
    // on-demand nodes below.
    { fn: "allNodes", name: "default seed", input: {} },

    // --- non-mutating lookups ------------------------------------------------
    { fn: "hasNode", name: "root exists", input: { id: "sql" } },
    {
      fn: "hasNode",
      name: "leaf exists",
      input: { id: "distributed-systems.caching.cache-invalidation" },
    },
    { fn: "hasNode", name: "unknown id", input: { id: "totally.unknown" } },
    { fn: "hasNode", name: "empty id", input: { id: "" } },

    { fn: "parentOf", name: "leaf parent", input: { id: "sql.indexing" } },
    { fn: "parentOf", name: "root has no parent", input: { id: "sql" } },
    {
      fn: "parentOf",
      name: "deep unknown id still has a syntactic parent",
      input: { id: "a.b.c.d" },
    },

    {
      fn: "ancestors",
      name: "leaf walks up to root",
      input: { id: "distributed-systems.caching.cache-invalidation" },
    },
    { fn: "ancestors", name: "root has none", input: { id: "sql" } },

    {
      fn: "childrenOf",
      name: "root children sorted",
      input: { id: "sql" },
    },
    {
      fn: "childrenOf",
      name: "mid-level children",
      input: { id: "distributed-systems" },
    },
    { fn: "childrenOf", name: "leaf has none", input: { id: "sql.indexing" } },
    {
      fn: "childrenOf",
      name: "unknown id has none",
      input: { id: "totally.unknown" },
    },

    {
      fn: "relatedTo",
      name: "sql.transactions cross-branch edges",
      input: { id: "sql.transactions" },
    },
    {
      fn: "relatedTo",
      name: "reverse direction is symmetric",
      input: { id: "distributed-systems.consistency" },
    },
    {
      fn: "relatedTo",
      name: "coding.complexity edge",
      input: { id: "coding.complexity" },
    },
    { fn: "relatedTo", name: "unrelated skill", input: { id: "apis" } },

    { fn: "labelFor", name: "seeded label", input: { id: "sql" } },
    {
      fn: "labelFor",
      name: "seeded mid label",
      input: { id: "distributed-systems.consistency" },
    },
    {
      fn: "labelFor",
      name: "unknown id humanizes the last segment",
      input: { id: "zzz.unknown-skill" },
    },

    // --- normalizeSkillId ------------------------------------------------------
    { fn: "normalizeSkillId", name: "case folded", input: { raw: "Python" } },
    {
      fn: "normalizeSkillId",
      name: "whitespace trimmed",
      input: { raw: "  sql  " },
    },
    { fn: "normalizeSkillId", name: "uppercase root", input: { raw: "APIS" } },
    {
      fn: "normalizeSkillId",
      name: "extra alias rest-api",
      input: { raw: "rest-api" },
    },
    {
      fn: "normalizeSkillId",
      name: "spaced alias rest api",
      input: { raw: "REST API" },
    },
    { fn: "normalizeSkillId", name: "extra alias mq", input: { raw: "mq" } },
    {
      fn: "normalizeSkillId",
      name: "extra alias cap-theorem",
      input: { raw: "cap-theorem" },
    },
    {
      fn: "normalizeSkillId",
      name: "extra alias cache-strategy",
      input: { raw: "cache-strategy" },
    },
    {
      fn: "normalizeSkillId",
      name: "dotted extra alias snaps to canonical",
      input: { raw: "system-design.requirements" },
    },
    {
      fn: "normalizeSkillId",
      name: "keyword alias postgres",
      input: { raw: "postgres" },
    },
    {
      fn: "normalizeSkillId",
      name: "keyword alias kubernetes",
      input: { raw: "Kubernetes" },
    },
    {
      fn: "normalizeSkillId",
      name: "unknown dotted id snaps last segment via alias",
      input: { raw: "coding.complexity-analysis" },
    },
    {
      fn: "normalizeSkillId",
      name: "unknown well-formed id passes through",
      input: { raw: "nonexistent-thing" },
    },
    {
      fn: "normalizeSkillId",
      name: "mixed case dotted passes through normalized",
      input: { raw: "UPPER.CASE" },
    },
    { fn: "normalizeSkillId", name: "empty string", input: { raw: "" } },
    {
      fn: "normalizeSkillId",
      name: "punctuation soup",
      input: { raw: "!!!" },
    },
    {
      fn: "normalizeSkillId",
      name: "double dots rejected",
      input: { raw: "a..b" },
    },

    // --- matchSkills -----------------------------------------------------------
    {
      fn: "matchSkills",
      name: "backend-engineer example job description",
      input: { text: BACKEND_ENGINEER_JD },
    },
    {
      fn: "matchSkills",
      name: "datastore keywords",
      input: { text: "Strong Redis and Kafka experience with PostgreSQL" },
    },
    {
      fn: "matchSkills",
      name: "api keywords",
      input: { text: "We need REST API design and HTTP endpoints" },
    },
    {
      fn: "matchSkills",
      name: "infrastructure keywords",
      input: { text: "kubernetes and observability tooling required" },
    },
    { fn: "matchSkills", name: "empty text", input: { text: "" } },
    {
      fn: "matchSkills",
      name: "python ecosystem keywords",
      input: { text: "I like pandas and numpy for data work" },
    },
    {
      fn: "matchSkills",
      name: "design keywords",
      input: { text: "system design and architecture discussion" },
    },
    {
      fn: "matchSkills",
      name: "punctuation separated keywords",
      input: { text: "SQL! PostgreSQL? transactions, acid." },
    },
    {
      fn: "matchSkills",
      name: "keyword inside a word does not match",
      input: { text: "classification apiculture respected" },
    },

    // --- getNode (mutating — on-demand nodes) — MUST stay last -----------------
    { fn: "getNode", name: "root node", input: { id: "sql" } },
    {
      fn: "getNode",
      name: "mid node",
      input: { id: "distributed-systems.caching" },
    },
    { fn: "getNode", name: "leaf node", input: { id: "sql.indexing" } },
    {
      fn: "getNode",
      name: "unknown valid id creates an on-demand node",
      input: { id: "custom.deep-skill" },
    },
    {
      fn: "getNode",
      name: "malformed id is undefined",
      input: { id: "Not A Skill!" },
    },
    { fn: "getNode", name: "empty id is undefined", input: { id: "" } },
    {
      fn: "getNode",
      name: "double-dot id is undefined",
      input: { id: "a..b" },
    },
  ],
};
