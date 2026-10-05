/**
 * Golden-fixture generator for the pure parts of packages/core.
 *
 *   node --import tsx tests/golden/generate.ts           # write the JSON files
 *   node --import tsx tests/golden/generate.ts --check   # exit 1 on any drift
 *
 * Each area file is `{ area, generatedFrom, cases }`; a case is
 * `{ fn, name, input, output }` — or `{ fn, name, input, error }` when the
 * function throws. `input` holds the named arguments as JSON; the runner
 * table below converts "now" ISO strings to `Date` before invoking.
 *
 * Serialization is deterministic: keys sorted, 2-space indent, trailing
 * newline, floats written as full JS numbers.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildReadinessGraph,
  builtinResourcesFor,
  calculateGaps,
  canTransition,
  computeSkillReadiness,
  confidenceForWeight,
  countFillers,
  difficultyFor,
  inRound,
  mergeResources,
  nextEvents,
  roundFallbackRequirements,
  selectNextSkill,
  statusForScore,
  transition,
  voiceFeedback,
  taxonomy,
} from "@interview-os/core";
import type {
  Evidence,
  InterviewEvent,
  InterviewStatus,
  Level,
  Requirement,
  RoundType,
  SelectNextSkillInput,
  SkillId,
  TaxonomyLike,
} from "@interview-os/core";

import { gapsCases } from "./cases/gaps.js";
import { prioritizeCases } from "./cases/prioritize.js";
import { readinessCases } from "./cases/readiness.js";
import { resourcesCases } from "./cases/resources.js";
import { roundsCases } from "./cases/rounds.js";
import { stateMachineCases } from "./cases/stateMachine.js";
import { taxonomyCases } from "./cases/taxonomy.js";
import { voiceCases } from "./cases/voice.js";
import type { AreaCases } from "./cases/helpers.js";

export const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url));

type Input = Record<string, unknown>;

/** Turn a JSON map spec into the TaxonomyLike the graph builder accepts. */
function taxonomyFrom(spec: Input): TaxonomyLike {
  const parentOf = (spec.parentOf ?? {}) as Record<string, string>;
  const labelFor = (spec.labelFor ?? {}) as Record<string, string>;
  const childrenOf = (spec.childrenOf ?? {}) as Record<string, string[]>;
  return {
    parentOf: (id: SkillId) => parentOf[id] ?? null,
    labelFor: (id: SkillId) => labelFor[id] ?? id,
    childrenOf: (id: SkillId) => childrenOf[id] ?? [],
  };
}

const RUNNERS: Record<string, (input: Input) => unknown> = {
  // readiness
  statusForScore: (i) => statusForScore(i.score as number | null),
  confidenceForWeight: (i) => confidenceForWeight(i.totalWeight as number),
  computeSkillReadiness: (i) =>
    computeSkillReadiness(i.evidence as Evidence[], new Date(i.now as string)),
  buildReadinessGraph: (i) =>
    buildReadinessGraph({
      evidence: (i.evidence ?? []) as Evidence[],
      requirements: (i.requirements ?? []) as Requirement[],
      now: new Date(i.now as string),
      ...(i.taxonomy ? { taxonomy: taxonomyFrom(i.taxonomy as Input) } : {}),
    }),
  // gaps
  calculateGaps: (i) =>
    calculateGaps({
      requirements: (i.requirements ?? []) as Requirement[],
      readiness: i.readiness as SelectNextSkillInput["readiness"],
      level: i.level as Level,
    }),
  // prioritize
  difficultyFor: (i) =>
    difficultyFor(i.level as Level, i.score as number | null),
  selectNextSkill: (i) => selectNextSkill(i as unknown as SelectNextSkillInput),
  // state machine
  transition: (i) =>
    transition(i.status as InterviewStatus, i.event as InterviewEvent),
  canTransition: (i) =>
    canTransition(i.status as InterviewStatus, i.event as InterviewEvent),
  nextEvents: (i) => nextEvents(i.status as InterviewStatus),
  // taxonomy (namespace export is `taxonomy` because index re-exports it)
  allNodes: () => taxonomy.allNodes(),
  getNode: (i) => taxonomy.getNode(i.id as string) ?? null,
  hasNode: (i) => taxonomy.hasNode(i.id as string),
  parentOf: (i) => taxonomy.parentOf(i.id as SkillId),
  ancestors: (i) => taxonomy.ancestors(i.id as SkillId),
  childrenOf: (i) => taxonomy.childrenOf(i.id as SkillId),
  relatedTo: (i) => taxonomy.relatedTo(i.id as SkillId),
  labelFor: (i) => taxonomy.labelFor(i.id as SkillId),
  normalizeSkillId: (i) => taxonomy.normalizeSkillId(i.raw as string),
  matchSkills: (i) => taxonomy.matchSkills(i.text as string),
  // rounds
  inRound: (i) => inRound(i.skillId as SkillId, i.roundType as RoundType),
  roundFallbackRequirements: (i) =>
    roundFallbackRequirements(i.roundType as RoundType),
  // voice
  countFillers: (i) => countFillers(i.text as string),
  voiceFeedback: (i) =>
    voiceFeedback(i.metrics as never, i.transcript as string),
  // resources
  builtinResourcesFor: (i) => builtinResourcesFor(i.skillId as SkillId),
  mergeResources: (i) =>
    mergeResources(...(i.lists as Parameters<typeof mergeResources>[0][])),
};

const AREAS: AreaCases[] = [
  readinessCases,
  gapsCases,
  prioritizeCases,
  stateMachineCases,
  taxonomyCases,
  roundsCases,
  voiceCases,
  resourcesCases,
];

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function runCase(c: { fn: string; name: string; input: Input }): Input {
  const runner = RUNNERS[c.fn];
  if (!runner) throw new Error(`no runner for fn "${c.fn}" (case "${c.name}")`);
  const entry: Input = { fn: c.fn, name: c.name, input: c.input };
  try {
    const out = runner(c.input);
    entry.output = out === undefined ? null : out;
  } catch (err) {
    const e = err as Error;
    entry.error = { name: e.name, message: e.message };
  }
  return entry;
}

/** filename → file contents (sorted keys, 2-space indent, trailing newline). */
export function buildFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const { area, cases } of AREAS) {
    const seen = new Set<string>();
    const entries = cases.map((c) => {
      if (seen.has(c.name)) {
        throw new Error(`duplicate case name "${c.name}" in area "${area}"`);
      }
      seen.add(c.name);
      return runCase(c);
    });
    const doc = { area, generatedFrom: "packages/core", cases: entries };
    files[`${area}.json`] = JSON.stringify(sortDeep(doc), null, 2) + "\n";
  }
  return files;
}

function main(): void {
  const files = buildFiles();
  const check = process.argv.includes("--check");
  const failures: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(GOLDEN_DIR, name);
    if (check) {
      if (!fs.existsSync(file)) {
        failures.push(`${name}: missing — run generate.ts`);
      } else if (fs.readFileSync(file, "utf8") !== content) {
        failures.push(`${name}: differs — run generate.ts`);
      }
    } else {
      fs.writeFileSync(file, content);
    }
  }
  if (check) {
    if (failures.length) {
      for (const f of failures) console.error(f);
      process.exitCode = 1;
    } else {
      console.log(`golden fixtures in sync (${Object.keys(files).length} files)`);
    }
  } else {
    for (const name of Object.keys(files)) console.log(`wrote ${name}`);
  }
}

const invokedAs = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedAs) main();
