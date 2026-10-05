/**
 * Declarative plugin-UI schema — canonical definitions live in
 * `@interview-os/frontend-types` (the manifest schema uses the action
 * vocabulary too); this subpath is the no-React import surface for servers and
 * tools.
 */
export {
  UIToneSchema,
  UIActionSchema,
  UINodeSchema,
  APP_ROUTE_ALLOWLIST,
  UI_TREE_LIMITS,
  validateUITree,
} from "@interview-os/frontend-types";
export type { UITone, UIAction, UINode } from "@interview-os/frontend-types";
