import type { ProgressUpdate } from "@interview-os/skills";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { errorStatus } from "./error.js";

export function wantsStream(c: Context): boolean {
  return (
    c.req.query("stream") === "1" ||
    (c.req.header("accept") ?? "").includes("text/event-stream")
  );
}

/**
 * Run an orchestrator operation with SSE progress when the client asked for it
 * (Accept: text/event-stream or ?stream=1). Events: `stage {name}`,
 * `delta {field, text}`, `result <same JSON as non-stream>`,
 * `error {code, message}` (HTTP stays 200 once streaming started). A client
 * disconnect never aborts the operation — writes just stop landing.
 */
export function streamOrJson<T>(
  c: Context,
  run: (onProgress: (p: ProgressUpdate) => void) => Promise<T>,
): Response | Promise<Response> {
  if (!wantsStream(c)) {
    return run(() => {}).then((r) => c.json(r));
  }
  return streamSSE(c, async (stream) => {
    // serialize writes — progress callbacks can't await
    let chain = Promise.resolve();
    const enqueue = (event: string, data: unknown) => {
      chain = chain
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {});
    };
    // heartbeat while the operation runs: keeps dev proxies flushing (the
    // Next.js rewrite proxy otherwise intermittently holds the tail bytes)
    // and gives clients a liveness signal during long silent stretches.
    const heartbeat = setInterval(() => enqueue("ping", {}), 10_000);
    try {
      const result = await run((p) => {
        if ("stage" in p) enqueue("stage", { name: p.stage });
        else enqueue("delta", { field: p.field, text: p.text });
      });
      await chain;
      await stream
        .writeSSE({ event: "result", data: JSON.stringify(result) })
        .catch(() => {});
    } catch (err) {
      const mapped = errorStatus(err);
      await chain;
      await stream
        .writeSSE({
          event: "error",
          data: JSON.stringify({ code: mapped.code, message: mapped.message }),
        })
        .catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  });
}
