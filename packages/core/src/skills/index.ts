export {
  PermissionSchema,
  SkillManifestInputSchema,
  SkillManifestSchema,
  PluginCapabilitySchema,
  PLUGIN_INPUT_KEYS,
  PLUGIN_WRITABLE_PERMISSIONS,
  SLUG_ID_REGEX,
  SlugIdSchema,
  isPluginWritable,
  isWritePermission,
  PLUGIN_UI_SLOTS,
  PluginUISlotSchema,
  PluginUIIconSchema,
  PluginUIContributionSchema,
  PluginUISchema,
  PluginInterviewModeSchema,
  PluginTaxonomyNodeSchema,
} from "./manifest.js";
export type {
  Permission,
  SkillManifest,
  SkillManifestInput,
  PluginInputKey,
  PluginCapability,
  NormalizedPluginCapability,
  PluginUISlot,
  PluginUIIcon,
  PluginUIContribution,
  PluginUI,
  PluginInterviewMode,
  PluginTaxonomyNode,
} from "./manifest.js";
export { describePermissions } from "./permissions.js";
export type {
  PermissionAccess,
  PermissionViewEntry,
} from "./permissions.js";
export {
  EvidenceProposalSchema,
  PluginOutputExtensionsSchema,
  PLUGIN_EVIDENCE_CONFIDENCE_CAP,
  PLUGIN_EVIDENCE_MAX_PROPOSALS,
  pluginEvidenceProposals,
} from "./proposals.js";
export type {
  EvidenceProposal,
  PluginOutputExtensions,
} from "./proposals.js";
