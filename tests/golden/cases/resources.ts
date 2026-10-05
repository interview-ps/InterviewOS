/**
 * Golden cases for packages/core/src/preparation/resources.ts:
 * builtinResourcesFor and mergeResources.
 */

import type { AreaCases } from "./helpers.js";

function res(
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { skillId: "sql", title, kind: "article", source: "test", ...extra };
}

export const resourcesCases: AreaCases = {
  area: "resources",
  cases: [
    // --- builtinResourcesFor --------------------------------------------------
    {
      fn: "builtinResourcesFor",
      name: "exact catalog hit sql.indexing",
      input: { skillId: "sql.indexing" },
    },
    {
      fn: "builtinResourcesFor",
      name: "exact catalog hit apis.rest",
      input: { skillId: "apis.rest" },
    },
    {
      fn: "builtinResourcesFor",
      name: "unknown child walks up to parent catalog",
      input: { skillId: "sql.no-such-subskill" },
    },
    {
      fn: "builtinResourcesFor",
      name: "grandchild walks up to caching",
      input: { skillId: "distributed-systems.caching.cache-invalidation" },
    },
    {
      fn: "builtinResourcesFor",
      name: "infrastructure.kubernetes",
      input: { skillId: "infrastructure.kubernetes" },
    },
    {
      fn: "builtinResourcesFor",
      name: "python root",
      input: { skillId: "python" },
    },
    {
      fn: "builtinResourcesFor",
      name: "behavioral root",
      input: { skillId: "behavioral" },
    },
    {
      fn: "builtinResourcesFor",
      name: "unknown skill gets only the practice entry",
      input: { skillId: "totally-unknown" },
    },
    {
      fn: "builtinResourcesFor",
      name: "system-design exact",
      input: { skillId: "system-design" },
    },

    // --- mergeResources ---------------------------------------------------------
    {
      fn: "mergeResources",
      name: "two disjoint lists keep order",
      input: {
        lists: [
          [res("A"), res("B")],
          [res("C"), res("D")],
        ],
      },
    },
    {
      fn: "mergeResources",
      name: "duplicate title and url is dropped",
      input: {
        lists: [
          [res("Same", { url: "https://a.example" }), res("B")],
          [res("Same", { url: "https://a.example" }), res("E")],
        ],
      },
    },
    {
      fn: "mergeResources",
      name: "same title with different url is kept",
      input: {
        lists: [
          [res("Same", { url: "https://a.example" })],
          [res("Same", { url: "https://b.example" })],
        ],
      },
    },
    {
      fn: "mergeResources",
      name: "missing url participates in the dedup key",
      input: {
        lists: [[res("NoUrl")], [res("NoUrl")]],
      },
    },
    {
      fn: "mergeResources",
      name: "empty lists and three-way merge",
      input: {
        lists: [[], [res("X")], [], [res("Y"), res("X")]],
      },
    },
  ],
};
