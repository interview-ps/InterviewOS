/**
 * Declarative plugin-UI schema — canonical definitions live in
 * `@interview-os/core` (the manifest schema uses the action vocabulary too);
 * this subpath is the no-React import surface for servers and tools.
 */
export {
  UIToneSchema,
  UIActionSchema,
  UINodeSchema,
  APP_ROUTE_ALLOWLIST,
  UI_TREE_LIMITS,
  validateUITree,
} from "@interview-os/core";
export type { UITone, UIAction, UINode } from "@interview-os/core";
