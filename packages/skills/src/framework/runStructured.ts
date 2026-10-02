import {
  RuntimeError,
  type JSONSchema,
  type RuntimeEvent,
} from "@interview-os/runtime";
import { z } from "zod";
import { extractPartialStringField } from "./partialJson.js";
import { SkillOutputError, SkillRuntimeError, type SkillContext } from "./skill.js";

const RETRYABLE_CODES = new Set(["MALFORMED_OUTPUT", "MALFORMED_EVENT"]);
const MAX_ATTEMPTS = 3; // initial + 2 retries

/**
 * Codex structured outputs require strict schemas: every object needs
 * additionalProperties:false and every property in `required`.
 */
export function toStrictJsonSchema(schema: z.ZodType): JSONSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" || obj.properties) {
      if (obj.properties && typeof obj.properties === "object") {
        obj.required = Object.keys(obj.properties as object);
        for (const prop of Object.values(obj.properties)) visit(prop);
      }
      obj.additionalProperties = false;
    }
    for (const key of ["items", "contains", "not", "if", "then", "else", "additionalProperties", "unevaluatedProperties", "propertyNames", "prefixItems"]) {
      const child = obj[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const arr = obj[key];
      if (Array.isArray(arr)) arr.forEach(visit);
    }
    if (obj.$defs && typeof obj.$defs === "object") {
      for (const def of Object.values(obj.$defs)) visit(def);
    }
  };
  visit(json);
  return json as JSONSchema;
}

export interface StructuredTaskOptions<O> {
  taskId: string;
  instructions: string;
  input: unknown;
  schema: z.ZodType<O>;
  /** Route through an existing runtime session instead of a one-shot task. */
  session?: { runtimeSessionId: string };
  /**
   * Stream partial values of this JSON field via ctx.onProgress({field, text})
   * while the model is still generating (§8.3).
   */
  streamField?: string;
}

async function runOnce(
  ctx: SkillContext,
  opts: StructuredTaskOptions<unknown>,
  instructions: string,
  outputSchema: JSONSchema,
  onDelta?: (text: string) => void,
): Promise<{ output?: unknown; raw: string }> {
  const sessionId = opts.session?.runtimeSessionId ?? ctx.runtimeSessionId;
  if (sessionId) {
    const started = Date.now();
    let completed: RuntimeEvent | undefined;
    for await (const event of ctx.runtime.sendMessage(sessionId, {
      text: `${instructions}\n\nInput (JSON):\n${JSON.stringify(opts.input)}`,
      taskId: opts.taskId,
      input: opts.input,
      outputSchema,
      model: ctx.runtimeOptions?.model ?? undefined,
      effort: ctx.runtimeOptions?.effort ?? undefined,
    })) {
      if (event.type === "error") throw event.error;
      if (event.type === "delta") onDelta?.(event.text);
      if (event.type === "completed") completed = event;
    }
    ctx.logger.info("runtime.invoked", {
      taskId: opts.taskId,
      latencyMs: Date.now() - started,
      ok: completed !== undefined,
      session: true,
    });
    if (!completed || completed.type !== "completed") {
      throw new RuntimeError("MALFORMED_EVENT", "session turn ended without a completed event");
    }
    if (completed.output !== undefined) {
      return { output: completed.output, raw: completed.raw };
    }
    try {
      return { output: JSON.parse(completed.raw), raw: completed.raw };
    } catch {
      throw new RuntimeError("MALFORMED_OUTPUT", "session output was not valid JSON");
    }
  }

  const result = await ctx.runtime.runTask({
    taskId: opts.taskId,
    instructions,
    input: opts.input,
    outputSchema,
    model: ctx.runtimeOptions?.model ?? undefined,
    effort: ctx.runtimeOptions?.effort ?? undefined,
    taskMode: ctx.runtimeOptions?.taskMode ?? undefined,
    onEvent: onDelta
      ? (e) => {
          if (e.type === "delta") onDelta(e.text);
        }
      : undefined,
  });
  ctx.logger.info("runtime.invoked", {
    taskId: opts.taskId,
    latencyMs: result.durationMs,
    ok: result.ok,
  });
  if (!result.ok) throw result.error;
  return { output: result.output, raw: result.raw };
}

export async function runStructured<O>(
  ctx: SkillContext,
  opts: StructuredTaskOptions<O>,
): Promise<O> {
  const outputSchema = toStrictJsonSchema(opts.schema);
  let instructions = opts.instructions;
  let lastError = "";

  ctx.logger.info("skill.invoked", {
    taskId: opts.taskId,
    sessionId: ctx.sessionId,
    runtimeSessionId: opts.session?.runtimeSessionId ?? ctx.runtimeSessionId,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let streamBuf = "";
    let lastSent = "";
    const onDelta =
      opts.streamField && ctx.onProgress
        ? (text: string) => {
            streamBuf += text;
            const field = opts.streamField!;
            const partial = extractPartialStringField(streamBuf, field);
            if (partial !== null && partial.length > lastSent.length) {
              lastSent = partial;
              ctx.onProgress!({ field, text: partial });
            }
          }
        : undefined;
    try {
      const { output } = await runOnce(ctx, opts, instructions, outputSchema, onDelta);
      const parsed = opts.schema.safeParse(output);
      if (parsed.success) {
        ctx.logger.info("output.validated", { taskId: opts.taskId, attempt });
        return parsed.data;
      }
      lastError = z.treeifyError?.(parsed.error)
        ? JSON.stringify(z.treeifyError(parsed.error)).slice(0, 2000)
        : parsed.error.message.slice(0, 2000);
      ctx.logger.warn("output.invalid", { taskId: opts.taskId, attempt });
    } catch (err) {
      if (err instanceof RuntimeError) {
        if (!RETRYABLE_CODES.has(err.code)) {
          throw new SkillRuntimeError(opts.taskId, err);
        }
        lastError = `${err.code}: ${err.message}`;
        ctx.logger.warn("output.invalid", {
          taskId: opts.taskId,
          attempt,
          code: err.code,
        });
      } else {
        throw err;
      }
    }
    instructions = `${opts.instructions}\n\nYour previous response was invalid: ${lastError}\nFix the output to satisfy the schema exactly.`;
    if (attempt < MAX_ATTEMPTS) ctx.onProgress?.({ stage: "retrying" });
  }
  throw new SkillOutputError(opts.taskId, lastError);
}
