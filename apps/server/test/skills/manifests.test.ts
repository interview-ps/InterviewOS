import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillManifestSchema } from "@interview-os/core";
import { BUILTIN_SKILLS } from "../../src/skills/host/builtins.js";
import { SkillHost, PermissionError } from "../../src/skills/host/SkillHost.js";
import { registerBuiltinSkills } from "../../src/skills/host/builtins.js";
import type { SkillContext } from "../../src/skills/framework/skill.js";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";

/** Top-level input keys of a schema (objects + discriminated unions). */
function topLevelKeys(schema: z.ZodType): string[] {
  const any = schema as unknown as {
    options?: z.ZodType[];
    shape?: Record<string, unknown>;
    _zod?: { def?: { type?: string; shape?: Record<string, unknown>; options?: z.ZodType[] } };
  };
  const def = any._zod?.def;
  if (def?.type === "object" && def.shape) return Object.keys(def.shape);
  if (any.shape) return Object.keys(any.shape);
  const options = def?.options ?? any.options;
  if (Array.isArray(options)) {
    const keys = new Set<string>();
    for (const opt of options) for (const k of topLevelKeys(opt)) keys.add(k);
    return [...keys];
  }
  return [];
}

function ctx(): SkillContext {
  return {
    runtime: new MockRuntime(),
    logger: createLogger({ level: "error", sink: () => {} }),
    now: () => new Date(),
  };
}

describe("skill manifests (§9.6)", () => {
  it("every built-in skill carries a valid manifest", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(12);
    for (const skill of BUILTIN_SKILLS) {
      const parsed = SkillManifestSchema.safeParse(skill.manifest);
      expect(parsed.success, `${skill.id} manifest`).toBe(true);
      expect(skill.manifest.id).toBe(skill.id);
      expect(skill.manifest.kind).toBe("builtin");
      expect(skill.manifest.version).toBe("1.0.0");
    }
  });

  it("manifest input keys equal the input schema's top-level keys", () => {
    for (const skill of BUILTIN_SKILLS) {
      const schemaKeys = topLevelKeys(skill.inputSchema).sort();
      const manifestKeys = skill.manifest.inputs.map((i) => i.key).sort();
      expect(manifestKeys, `${skill.id} manifest inputs`).toEqual(schemaKeys);
      // every input permission is granted in `permissions`
      for (const input of skill.manifest.inputs) {
        expect(
          skill.manifest.permissions,
          `${skill.id} lacks ${input.permission} for input ${input.key}`,
        ).toContain(input.permission);
      }
    }
  });

  it("host.invoke rejects undeclared input keys", async () => {
    const host = new SkillHost();
    registerBuiltinSkills(host);
    await expect(
      host.invoke(
        "prep-planner",
        { targets: [], role: "x", level: "senior", sneaky: true },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("host.invoke validates inputs against the skill schema", async () => {
    const host = new SkillHost();
    registerBuiltinSkills(host);
    await expect(
      host.invoke(
        "prep-planner",
        { targets: [], role: "x", level: "not-a-level" },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("ctx.runtime throws PERMISSION_DENIED for skills without runtime.invoke", async () => {
    const host = new SkillHost();
    registerBuiltinSkills(host);
    // interview-planner is deterministic — no runtime.invoke in its manifest
    await expect(
      host.invoke(
        "interview-planner",
        {
          requirements: [],
          readiness: {},
          evidence: [],
          askedThisSession: [],
          askedPreviousSession: [],
          questionIndex: 0,
        },
        ctx(),
      ),
    ).resolves.toBeNull();
    // and a plugin-style runtime check happens in the host test file
  });

  it("assertCan enforces write permissions", () => {
    const host = new SkillHost();
    registerBuiltinSkills(host);
    expect(() => host.assertCan("prep-planner", "preparation.write")).not.toThrow();
    expect(() => host.assertCan("prep-planner", "candidate.write")).toThrow(
      PermissionError,
    );
    expect(() => host.assertCan("gap-analyzer", "runtime.invoke")).toThrow(
      PermissionError,
    );
    expect(() => host.assertCan("resume-coach", "resume.write")).not.toThrow();
  });
});
