import { AppError } from "@interview-os/core";
import type { Context } from "hono";
import { z } from "zod";

export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("VALIDATION", "request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION",
      `invalid request body: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Parses a JSON body, treating an empty body as `undefined`. */
export async function parseOptionalBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S> | undefined> {
  const text = await c.req.text();
  if (text.trim() === "") return undefined;
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new AppError("VALIDATION", "invalid request body");
  }
}
