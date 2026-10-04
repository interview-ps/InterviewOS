import {
  FrameEnvelopeSchema,
  type FrameEnvelope,
  type FrameMessageType,
  type PluginFrameContext,
  type PluginFrameRunResult,
  type PluginFrameSDK,
} from "../frame.js";
import type { UIAction } from "@interview-os/core";

const REQUEST_TIMEOUT_MS = 15_000;
let seq = 0;

/**
 * Iframe-side SDK. Every method posts a validated envelope to the parent
 * window (opaque origin → targetOrigin "*" is required and safe here: the
 * parent is the frame's only possible embedder and replies are routed by
 * message id, not inspected for secrets they don't already own).
 */
export function createPluginSDK(): PluginFrameSDK {
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
  >();

  function send(type: FrameMessageType, payload?: unknown): string {
    const id = `f${Date.now().toString(36)}_${++seq}`;
    const msg: FrameEnvelope = { v: 1, id, type, payload };
    window.parent.postMessage(msg, "*");
    return id;
  }

  function request<T>(type: FrameMessageType, payload?: unknown): Promise<T> {
    const id = send(type, payload);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`plugin frame: "${type}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
    });
  }

  window.addEventListener("message", (event) => {
    // The host is the parent; an opaque origin reports origin "null", so the
    // source window is the only reliable identity check on this side too.
    if (event.source !== window.parent) return;
    const parsed = FrameEnvelopeSchema.safeParse(event.data);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type !== "result" && msg.type !== "error") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    window.clearTimeout(p.timer);
    if (msg.type === "error") {
      p.reject(
        new Error(
          typeof msg.payload === "object" && msg.payload !== null
            ? String((msg.payload as { message?: unknown }).message ?? "host error")
            : "host error",
        ),
      );
    } else {
      p.resolve(msg.payload);
    }
  });

  return {
    ready: () => request<PluginFrameContext>("ready"),
    getData: () => request<Record<string, unknown>>("getData"),
    run: (req) => request<PluginFrameRunResult>("run", { request: req }),
    action: (action: UIAction) => request<void>("action", { action }),
    resize: (height: number) => void send("resize", { height }),
  };
}
