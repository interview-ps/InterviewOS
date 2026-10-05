import { z } from "zod";
import type { ReactNode } from "react";
import type { UIAction, UINode } from "@interview-os/frontend-types";
import type { Theme } from "./tokens.js";

/**
 * v0.4 plugin UI Level 2 — the postMessage contract between a sandboxed
 * plugin iframe (opaque origin) and the Interview OS host page. The iframe
 * initiates every exchange; the parent validates the envelope, the source
 * window, and the payload before acting.
 */

export const FRAME_MESSAGE_TYPES = [
  "ready",
  "getData",
  "run",
  "action",
  "resize",
  "result",
  "error",
] as const;
export type FrameMessageType = (typeof FRAME_MESSAGE_TYPES)[number];

export const FrameEnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(64),
  type: z.enum(FRAME_MESSAGE_TYPES),
  payload: z.unknown().optional(),
});
export type FrameEnvelope = z.infer<typeof FrameEnvelopeSchema>;

/** Max serialized bytes for one bridge message (parent drops larger). */
export const FRAME_MAX_MESSAGE_BYTES = 64 * 1024;
/** Max iframe→parent messages per second; excess are dropped. */
export const FRAME_MAX_MESSAGES_PER_SEC = 20;
/** Parent clamps reported heights into this range. */
export const FRAME_MIN_HEIGHT = 80;
export const FRAME_MAX_HEIGHT = 1600;

/** Context the host hands to the frame once it says `ready`. */
export interface PluginFrameContext {
  pluginId: string;
  component?: string;
  page?: string;
  theme: Theme;
  params?: unknown;
}

/** Result of an `sdk.run()` round-trip through the isolated plugin. */
export interface PluginFrameRunResult {
  output: unknown;
  /** present when the plugin returned a valid declarative tree */
  ui?: UINode;
}

/** The iframe-side SDK — the only channel a frame has to Interview OS. */
export interface PluginFrameSDK {
  /** Resolve the host-provided context (plugin id, target, theme, params). */
  ready(): Promise<PluginFrameContext>;
  /** The plugin's declared + user-granted state slices (server-assembled). */
  getData(): Promise<Record<string, unknown>>;
  /** Stateless plugin invocation: request → isolated run → raw output. */
  run(request: Record<string, unknown>): Promise<PluginFrameRunResult>;
  /** Closed-vocabulary UI action (navigate/startInterview/startPractice/…). */
  action(action: UIAction): Promise<void>;
  /** Ask the host to resize the iframe (clamped 80–1600 px). */
  resize(height: number): void;
}

export interface PluginFrameProps {
  sdk: PluginFrameSDK;
}

export type PluginFrameComponent = (props: PluginFrameProps) => ReactNode;

/** What a plugin's built `ui/index.js` default-exports. */
export interface PluginFrameModule {
  components?: Record<string, PluginFrameComponent>;
  pages?: Record<string, PluginFrameComponent>;
}

/* -- host-side pure helpers (shared with the parent bridge) ------------------- */

/** Parse + size-check an inbound message; null means "drop silently". */
export function parseFrameMessage(data: unknown): FrameEnvelope | null {
  try {
    if (JSON.stringify(data).length > FRAME_MAX_MESSAGE_BYTES) return null;
  } catch {
    return null;
  }
  const parsed = FrameEnvelopeSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Clamp a plugin-reported iframe height into the allowed range. */
export function clampFrameHeight(height: unknown): number {
  const n =
    typeof height === "number" && Number.isFinite(height)
      ? height
      : FRAME_MIN_HEIGHT;
  return Math.min(
    FRAME_MAX_HEIGHT,
    Math.max(FRAME_MIN_HEIGHT, Math.round(n)),
  );
}

/** Sliding-window per-frame rate limiter; excess messages are dropped. */
export function createFrameRateLimiter(
  max = FRAME_MAX_MESSAGES_PER_SEC,
  windowMs = 1000,
  now: () => number = () => Date.now(),
): () => boolean {
  const hits: number[] = [];
  return () => {
    const t = now();
    while (hits.length > 0 && (hits[0] as number) <= t - windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  };
}
