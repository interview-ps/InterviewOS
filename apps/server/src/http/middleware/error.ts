import { RuntimeError } from "@interview-os/runtime";
import { AppError } from "@interview-os/core";
import { SkillRuntimeError, SkillOutputError } from "../../skills/index.js";
import type { Context } from "hono";

export interface HttpError {
  status: number;
  code: string;
  message: string;
}

/**
 * Single translation point from every layer's error taxonomy to HTTP. This is
 * the only module in the server allowed to know about `@interview-os/skills`.
 */
export function errorStatus(err: unknown): HttpError {
  if (err instanceof SkillRuntimeError) {
    if (err.runtimeCode === "UNAVAILABLE") {
      return { status: 503, code: "UNAVAILABLE", message: err.message };
    }
    if (err.runtimeCode === "TIMEOUT") {
      return {
        status: 504,
        code: "RUNTIME_TIMEOUT",
        message: `The AI runtime timed out while running "${err.taskId}". ${err.message}`,
      };
    }
    return {
      status: 502,
      code: "RUNTIME_FAILED",
      message: `The AI runtime failed while running "${err.taskId}". ${err.message}`,
    };
  }
  if (err instanceof RuntimeError && err.code === "UNAVAILABLE") {
    return { status: 503, code: "UNAVAILABLE", message: err.message };
  }
  if (err instanceof RuntimeError) {
    if (err.code === "TIMEOUT") {
      return { status: 504, code: "RUNTIME_TIMEOUT", message: err.message };
    }
    return { status: 502, code: "RUNTIME_FAILED", message: err.message };
  }
  if (err instanceof SkillOutputError) {
    return { status: 502, code: err.code, message: err.message };
  }
  if (err instanceof AppError) {
    if (err.code === "INVALID_TRANSITION")
      return { status: 409, code: err.code, message: err.message };
    if (err.code === "NOT_FOUND")
      return { status: 404, code: err.code, message: err.message };
    if (err.code === "NO_ACTIVE_PROFILE")
      return { status: 409, code: err.code, message: err.message };
    if (err.code === "UNSUPPORTED_FORMAT")
      return { status: 415, code: err.code, message: err.message };
    if (err.code === "EXTRACTION_FAILED")
      return { status: 422, code: err.code, message: err.message };
    if (err.code === "VALIDATION")
      return { status: 400, code: err.code, message: err.message };
    return { status: 400, code: err.code, message: err.message };
  }
  return {
    status: 500,
    code: "INTERNAL",
    message: err instanceof Error ? err.message : String(err),
  };
}

export function onError(err: Error, c: Context) {
  const mapped = errorStatus(err);
  return c.json(
    { error: { code: mapped.code, message: mapped.message } },
    mapped.status as 400,
  );
}
