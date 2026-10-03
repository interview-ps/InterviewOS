import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { AppError } from "@interview-os/core";
import { extractDocument } from "../../adapters/documents.js";

export const documentsRoutes = new Hono<AppEnv>();

documentsRoutes.post("/extract", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new AppError("VALIDATION", "multipart field 'file' is required");
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const result = await extractDocument(buf, file.name);
  // lengths only — never log document contents
  c.var.logger.info("document.extracted", {
    nameLength: file.name.length,
    bytes: buf.length,
    format: result.format,
    chars: result.text.length,
  });
  return c.json(result);
});
