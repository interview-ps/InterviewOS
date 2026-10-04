import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";
import { SlugIdSchema } from "../skills/slug.js";
import { RoundTypeSchema } from "../interview/rounds.js";

/**
 * v0.4 plugin UI extensions — declarative UI trees and the closed action
 * vocabulary. Pure Zod (no React) so the server can validate plugin output
 * and the web host can render it.
 */

export const UIToneSchema = z.enum(["green", "amber", "red", "blue", "muted"]);
export type UITone = z.infer<typeof UIToneSchema>;

/** Routes a plugin `navigate` action may target. */
export const APP_ROUTE_ALLOWLIST = [
  "/",
  "/target",
  "/prepare",
  "/prepare/stories",
  "/interview",
  "/readiness",
  "/resume",
  "/history",
  "/skills",
  "/packs",
  "/settings",
] as const;

export const UIActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("navigate"),
    /** an allowlisted app route, or a path under the plugin's own /plugins/<id> */
    to: z.string().min(1).max(300),
  }),
  z.strictObject({
    type: z.literal("startInterview"),
    roundType: RoundTypeSchema.optional(),
    /** one of the plugin's declared interviewModes ids */
    modeId: SlugIdSchema.optional(),
    plannedQuestions: z.number().int().min(1).max(10).optional(),
  }),
  z.strictObject({
    type: z.literal("startPractice"),
    skillId: SkillIdSchema,
  }),
  z.strictObject({
    type: z.literal("runPlugin"),
    /** arbitrary JSON payload re-sent to the plugin (≤ 2 KB) */
    request: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    type: z.literal("openPluginPage"),
    /** path relative to /plugins/<id> — must start with "/" */
    path: z.string().regex(/^\//, "page path must start with /").max(120),
  }),
]);
export type UIAction = z.infer<typeof UIActionSchema>;

/** A UI action path must be a plain in-app path — no traversal, escapes, or
 *  query/fragment smuggling. Returns the rejection reason or null. */
export function uiPathError(path: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(path)) return "contains a control character";
  if (path.includes("..")) return "contains '..'";
  if (path.includes("//")) return "contains '//'";
  if (path.includes("\\")) return "contains a backslash";
  if (/[?#]/.test(path)) return "contains a query/fragment separator";
  if (/%2e|%2f/i.test(path)) return "contains an encoded traversal character";
  return null;
}

const text500 = z.string().max(500);

const childNodes = () => z.array(z.lazy(() => UINodeSchema));

export const UINodeSchema: z.ZodType<UINode> = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stack"),
    gap: z.enum(["sm", "md", "lg"]).optional(),
    children: childNodes(),
  }),
  z.strictObject({ type: z.literal("row"), children: childNodes() }),
  z.strictObject({
    type: z.literal("card"),
    title: text500.optional(),
    subtitle: text500.optional(),
    children: childNodes(),
  }),
  z.strictObject({
    type: z.literal("heading"),
    text: text500.min(1),
    level: z.union([z.literal(2), z.literal(3)]).default(2),
  }),
  z.strictObject({ type: z.literal("text"), text: text500.min(1), tone: UIToneSchema.optional() }),
  z.strictObject({
    type: z.literal("stat"),
    label: text500.min(1),
    value: text500.min(1),
    trend: z.enum(["up", "down", "flat"]).optional(),
    tone: UIToneSchema.optional(),
  }),
  z.strictObject({ type: z.literal("badge"), text: text500.min(1), tone: UIToneSchema }),
  z.strictObject({
    type: z.literal("skillScore"),
    skillId: SkillIdSchema,
    label: text500.optional(),
    score: z.number().min(0).max(1).nullable(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    type: z.literal("progressList"),
    items: z
      .array(
        z.strictObject({
          label: text500.min(1),
          value: z.number().min(0).max(1),
          tone: UIToneSchema.optional(),
        }),
      )
      .max(50),
  }),
  z.strictObject({
    type: z.literal("list"),
    items: z
      .array(z.strictObject({ text: text500.min(1), tone: UIToneSchema.optional() }))
      .max(50),
  }),
  z.strictObject({
    type: z.literal("evidenceList"),
    items: z
      .array(
        z.strictObject({
          skillId: SkillIdSchema,
          observation: text500.min(1),
          score: z.number().min(0).max(1).optional(),
          createdAt: z.string().max(40).optional(),
        }),
      )
      .max(50),
  }),
  z.strictObject({
    type: z.literal("readinessChart"),
    points: z.array(z.number().min(0).max(1)).max(200),
    label: text500.optional(),
  }),
  z.strictObject({
    type: z.literal("tabs"),
    tabs: z
      .array(z.strictObject({ label: text500.min(1), children: childNodes() }))
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("emptyState"),
    title: text500.min(1),
    description: text500.optional(),
  }),
  z.strictObject({ type: z.literal("divider") }),
  z.strictObject({
    type: z.literal("button"),
    label: text500.min(1),
    variant: z.enum(["primary", "secondary"]).optional(),
    action: UIActionSchema,
  }),
]) as z.ZodType<UINode>;

export type UINode =
  | { type: "stack"; gap?: "sm" | "md" | "lg"; children: UINode[] }
  | { type: "row"; children: UINode[] }
  | { type: "card"; title?: string; subtitle?: string; children: UINode[] }
  | { type: "heading"; text: string; level: 2 | 3 }
  | { type: "text"; text: string; tone?: UITone }
  | { type: "stat"; label: string; value: string; trend?: "up" | "down" | "flat"; tone?: UITone }
  | { type: "badge"; text: string; tone: UITone }
  | { type: "skillScore"; skillId: string; label?: string; score: number | null; confidence?: number }
  | { type: "progressList"; items: { label: string; value: number; tone?: UITone }[] }
  | { type: "list"; items: { text: string; tone?: UITone }[] }
  | {
      type: "evidenceList";
      items: { skillId: string; observation: string; score?: number; createdAt?: string }[];
    }
  | { type: "readinessChart"; points: number[]; label?: string }
  | { type: "tabs"; tabs: { label: string; children: UINode[] }[] }
  | { type: "emptyState"; title: string; description?: string }
  | { type: "divider" }
  | { type: "button"; label: string; variant?: "primary" | "secondary"; action: UIAction };

export const UI_TREE_LIMITS = {
  maxDepth: 8,
  maxNodes: 300,
  maxSerializedBytes: 64 * 1024,
  maxRunPluginRequestBytes: 2 * 1024,
} as const;

function checkAction(action: UIAction, pluginId: string | undefined, path: string): string | null {
  switch (action.type) {
    case "navigate": {
      const to = action.to;
      const bad = uiPathError(to);
      if (bad) return `${path}: navigate target "${to}" ${bad}`;
      if ((APP_ROUTE_ALLOWLIST as readonly string[]).includes(to)) return null;
      if (
        pluginId &&
        (to === `/plugins/${pluginId}` || to.startsWith(`/plugins/${pluginId}/`))
      )
        return null;
      return `${path}: navigate target "${to}" is not an allowlisted route or a page under this plugin`;
    }
    case "startInterview":
      return null;
    case "startPractice":
      return null;
    case "runPlugin": {
      let bytes = 0;
      try {
        bytes = JSON.stringify(action.request).length;
      } catch {
        return `${path}: runPlugin request is not JSON-serializable`;
      }
      if (bytes > UI_TREE_LIMITS.maxRunPluginRequestBytes) {
        return `${path}: runPlugin request exceeds ${UI_TREE_LIMITS.maxRunPluginRequestBytes} bytes`;
      }
      return null;
    }
    case "openPluginPage": {
      const bad = uiPathError(action.path);
      if (bad) return `${path}: openPluginPage path "${action.path}" ${bad}`;
      return null;
    }
  }
}

/**
 * Parse + bound a declarative UI tree. Throws an Error describing the first
 * violation. `opts.pluginId` enables the same-plugin navigate allowance.
 */
export function validateUITree(
  tree: unknown,
  opts: { pluginId?: string } = {},
): UINode {
  const serialized = JSON.stringify(tree);
  if (serialized === undefined || serialized.length > UI_TREE_LIMITS.maxSerializedBytes) {
    throw new Error(
      `ui tree exceeds ${UI_TREE_LIMITS.maxSerializedBytes} bytes`,
    );
  }
  const parsed = UINodeSchema.parse(tree);
  let nodes = 0;
  const walk = (node: UINode, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > UI_TREE_LIMITS.maxNodes) {
      throw new Error(`ui tree exceeds ${UI_TREE_LIMITS.maxNodes} nodes`);
    }
    if (depth > UI_TREE_LIMITS.maxDepth) {
      throw new Error(`ui tree exceeds depth ${UI_TREE_LIMITS.maxDepth}`);
    }
    if (node.type === "button") {
      const err = checkAction(node.action, opts.pluginId, path);
      if (err) throw new Error(err);
    }
    const children: UINode[] =
      "children" in node
        ? node.children
        : node.type === "tabs"
          ? node.tabs.flatMap((t) => t.children)
          : [];
    children.forEach((c, i) => walk(c, depth + 1, `${path}.${i}`));
  };
  walk(parsed, 1, "root");
  return parsed;
}
