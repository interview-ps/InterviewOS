import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  CandidateProfileSchema,
  PLUGIN_EVIDENCE_CONFIDENCE_CAP,
  TargetRoleSchema,
  capabilityHooks,
  describePermissions,
  hookRequestSchema,
  hookResponseSchema,
  isPluginHookName,
  LEGACY_HOOK_KIND,
  newId,
  pluginEvidenceProposals,
  PluginPrepActivitySchema,
  taxonomy,
  validateUITree,
  type AnswerEvaluation,
  type HookRequest,
  type HookResponse,
  type Gap,
  type Permission,
  type PermissionViewEntry,
  type NormalizedPluginCapability,
  type PluginHookName,
  type PluginInterviewMode,
  type PluginReviewObservation,
  type PluginSettingField,
  type PluginUI,
  type PluginUISlot,
  type PluginPrepActivity,
  type ReadinessGraph,
  type SkillManifest,
  type UINode,
} from "@interview-os/core";
import { findEntryFile, loadManifestFile } from "@interview-os/plugin-sdk";
import {
  PluginError,
  isManifestCompatible,
  type PluginExecutor,
  type PluginStateSlices,
} from "../skills/index.js";
import type { PluginKvStorage } from "../skills/framework/skill.js";
import { createIsolatedExecutor } from "../plugins/executor.js";
import { cloneShallow, validateGitSource } from "../adapters/git.js";
import type { WorkflowContext } from "./context.js";
import type { PluginInstallRow } from "./store/index.js";

export type PluginSource = "bundled" | "git" | "memory";

export interface PluginRegistrationMeta {
  dir?: string;
  entryFile?: string;
  source?: PluginSource;
  /** Hook names the plugin implements (manifest `hooks` ∪ runner describe). */
  hooks?: string[];
}

interface RegistryEntry {
  manifest: SkillManifest;
  dir?: string;
  source: PluginSource;
  hooks: string[];
}

export interface PluginView {
  manifest: SkillManifest;
  enabled: boolean;
  grantedPermissions: Permission[];
  source: PluginSource;
  compatible: boolean;
  permissions: PermissionViewEntry[];
  loadError?: string;
}

export interface PluginRunResult {
  output: unknown;
  evidenceWritten: number;
  evidenceIgnored: number;
  evidenceRejected?: string;
}

export interface PluginDirs {
  bundled: string;
  installed: string;
}

/** v0.4: request for a declarative UI render (slot contribution or page). */
export interface PluginUIRenderRequest {
  slot?: string;
  component: string;
  page?: string;
  params?: unknown;
}

/** v0.4: what an enabled plugin contributes to the host UI. */
export interface PluginUIContributionView {
  pluginId: string;
  pluginName: string;
  navigation: PluginUI["navigation"];
  commands: PluginUI["commands"];
  slots: PluginUI["slots"];
  pages: PluginUI["pages"];
  interviewModes: PluginInterviewMode[];
}

export interface PluginServiceDeps {
  ctx: WorkflowContext;
  graphForActive(): Promise<ReadinessGraph>;
  calculateGaps(): Promise<Gap[]>;
  recomputeReadiness(reason: string): Promise<ReadinessGraph>;
  pluginDirs?: PluginDirs;
}

/** Reads + runtime.invoke are auto-grantable; evidence.write never is. */
function autoGrantable(manifest: SkillManifest): Permission[] {
  return manifest.permissions.filter(
    (p) => p.endsWith(".read") || p === "runtime.invoke",
  );
}

export class PluginService {
  private readonly registry = new Map<string, RegistryEntry>();
  private loadErrors: { dir: string; file: string; error: string }[] = [];

  constructor(private readonly deps: PluginServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  setPluginLoadErrors(errors: { dir: string; file: string; error: string }[]): void {
    this.loadErrors = errors;
  }

  /** Register a plugin skill on the host (the server-side loader validates first). */
  registerPlugin(
    manifest: SkillManifest,
    executor: PluginExecutor,
    meta: PluginRegistrationMeta = {},
  ): void {
    const hooks = [
      ...new Set([...(manifest.hooks ?? []), ...(meta.hooks ?? [])]),
    ];
    this.checkCapabilityHooks(manifest, meta.dir, hooks);
    this.ctx.host.registerPlugin(manifest, executor);
    const parsed = { ...manifest, kind: "plugin" as const };
    this.registry.set(manifest.id, {
      manifest: parsed,
      dir: meta.dir,
      source: meta.source ?? "memory",
      hooks,
    });
  }

  /**
   * Plugin API v1: every declared capability must be backed by something that
   * can answer its hooks — declared `hooks`, reported handlers, or (with a
   * warning) a legacy catch-all `execute`.
   */
  private checkCapabilityHooks(
    manifest: SkillManifest,
    dir: string | undefined,
    hooks: string[],
  ): void {
    const caps = manifest.capabilities ?? [];
    const declared = manifest.hooks !== undefined || hooks.length > 0;
    // manifest `hooks` names must be real Plugin API hooks.
    for (const h of manifest.hooks ?? []) {
      if (!isPluginHookName(h)) {
        throw new AppError(
          "PLUGIN_INSTALL",
          `plugin "${manifest.id}" declares unknown hook "${h}"`,
        );
      }
    }
    if (caps.length === 0) return;

    const shipDir = (sub: string) =>
      dir !== undefined && existsSync(path.join(dir, "packs", sub));
    const shipsCompany = shipDir("companies");
    const shipsRoles = shipDir("roles");
    if (shipsCompany && !caps.includes("company_pack")) {
      throw new AppError(
        "PLUGIN_INSTALL",
        `plugin "${manifest.id}" ships packs/companies but lacks the company_pack capability`,
      );
    }
    if (shipsRoles && !caps.includes("role_pack")) {
      throw new AppError(
        "PLUGIN_INSTALL",
        `plugin "${manifest.id}" ships packs/roles but lacks the role_pack capability`,
      );
    }

    const backs = (cap: NormalizedPluginCapability): boolean => {
      if (!declared) return true; // legacy execute is the catch-all
      if (cap === "interview") {
        return (
          (manifest.interviewModes?.length ?? 0) > 0 ||
          hooks.includes("questions.suggest")
        );
      }
      if (cap === "company_pack") return shipsCompany;
      if (cap === "role_pack") return shipsRoles;
      return capabilityHooks(cap).some((h) => hooks.includes(h));
    };

    for (const cap of caps) {
      if (!backs(cap)) {
        throw new AppError(
          "PLUGIN_INSTALL",
          `plugin "${manifest.id}" declares capability "${cap}" with no hook backing it ` +
            `(need one of: ${
              cap === "interview"
                ? "interviewModes or questions.suggest"
                : cap === "company_pack" || cap === "role_pack"
                  ? `packs/${cap === "company_pack" ? "companies" : "roles"}/`
                  : capabilityHooks(cap).join(", ")
            })`,
        );
      }
    }

    if (!declared) {
      this.ctx.logger.warn("plugin.hooks_undeclared", {
        plugin: manifest.id,
        detail:
          "legacy execute assumed to cover declared capabilities; declare `hooks` in skill.yaml",
      });
    }
  }

  /** All registered manifests — built-ins and loaded plugins. */
  listSkillManifests(): SkillManifest[] {
    return this.ctx.host.manifests();
  }

  private async ensureInstallRow(
    entry: RegistryEntry,
  ): Promise<PluginInstallRow> {
    const existing = await this.ctx.store.getPluginInstall(entry.manifest.id);
    if (existing) return existing;
    const row: PluginInstallRow = {
      id: entry.manifest.id,
      enabled: entry.source === "git" ? 0 : 1,
      grantedPermissions:
        entry.source === "git" ? [] : autoGrantable(entry.manifest),
      source: entry.source === "memory" ? "bundled" : entry.source,
      sourceUrl: null,
      dirName: entry.dir ? path.basename(entry.dir) : null,
      installedAt: this.ctx.iso(),
      updatedAt: this.ctx.iso(),
    };
    await this.ctx.store.upsertPluginInstall(row);
    return row;
  }

  async listPlugins(): Promise<PluginView[]> {
    const views: PluginView[] = [];
    for (const entry of this.registry.values()) {
      const row = await this.ensureInstallRow(entry);
      const granted = (row.grantedPermissions as Permission[]).filter((p) =>
        entry.manifest.permissions.includes(p),
      );
      const dirName = entry.dir ? path.basename(entry.dir) : undefined;
      views.push({
        manifest: entry.manifest,
        enabled: row.enabled === 1,
        grantedPermissions: granted,
        source: entry.source,
        compatible: isManifestCompatible(entry.manifest),
        permissions: describePermissions(entry.manifest, granted, {
          enabled: row.enabled === 1,
        }),
        loadError: this.loadErrors.find((e) => e.dir === dirName)?.error,
      });
    }
    return views;
  }

  async setPluginEnabled(
    id: string,
    enabled: boolean,
    grantedPermissions?: Permission[],
  ): Promise<PluginView> {
    const entry = this.registry.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    const row = await this.ensureInstallRow(entry);
    if (grantedPermissions) {
      const allowed = new Set(entry.manifest.permissions);
      const bad = grantedPermissions.find((p) => !allowed.has(p));
      if (bad) {
        throw new AppError(
          "VALIDATION",
          `grant "${bad}" is not requested by plugin "${id}"`,
        );
      }
    }
    const granted =
      grantedPermissions ??
      (enabled ? autoGrantable(entry.manifest) : (row.grantedPermissions as Permission[]));
    await this.ctx.store.upsertPluginInstall({
      ...row,
      enabled: enabled ? 1 : 0,
      grantedPermissions: granted,
      updatedAt: this.ctx.iso(),
    });
    this.ctx.bumpUIEpoch();
    await this.syncPluginPacks();
    const view = (await this.listPlugins()).find((v) => v.manifest.id === id);
    if (!view) throw new AppError("INTERNAL", `plugin "${id}" view missing`);
    return view;
  }

  /** Shared slice assembly + granted invocation; used by runPlugin and the
   *  question/resource source paths (which never persist plugin evidence). */
  private async invokePluginInternal(
    id: string,
    request: unknown,
    opts?: { hook?: PluginHookName; hookRequest?: unknown },
  ): Promise<{ output: unknown; granted: Permission[]; candidateId: string | null }> {
    const { slices, granted, candidateId, entry } = await this.assembleSlices(id, request);
    const output = await this.ctx.host.invokePlugin(
      id,
      slices,
      await this.ctx.ctx(),
      {
        granted,
        hook: opts?.hook,
        hookRequest: opts?.hookRequest,
        settings: await this.getPluginSettings(entry.manifest.id),
        storage: this.storageFor(entry.manifest.id),
      },
    );
    return { output, granted, candidateId };
  }

  /**
   * Plugin API v1: invoke a typed hook. The request is validated before send
   * and the response after receipt; legacy plugins see the hook's legacy
   * `request.kind` shape so `request.kind === "ui"` style code keeps working.
   */
  async invokeHook(
    id: string,
    hook: PluginHookName,
    req: unknown,
  ): Promise<{ output: unknown; granted: Permission[] }> {
    const parsed = hookRequestSchema(hook).safeParse(req);
    if (!parsed.success) {
      throw new PluginError(
        "PLUGIN_OUTPUT",
        `plugin "${id}" hook "${hook}" request failed validation`,
      );
    }
    req = parsed.data;
    const legacyRequest = {
      ...(req as Record<string, unknown>),
      kind: LEGACY_HOOK_KIND[hook],
    };
    const declared =
      this.registry.get(id)?.hooks.includes(hook) ?? false;
    const { output, granted } = await this.invokePluginInternal(id, legacyRequest, {
      hook,
      hookRequest: req,
    });
    // Declared-hook plugins are held to the contract; legacy plugins keep
    // their pre-v1 free-form output (callers post-validate what they use).
    if (declared) {
      const parsed = hookResponseSchema(hook).safeParse(output);
      if (!parsed.success) {
        throw new PluginError(
          "PLUGIN_OUTPUT",
          `plugin "${id}" hook "${hook}" returned an invalid response`,
        );
      }
      return { output: parsed.data, granted };
    }
    return { output, granted };
  }

  /** Plugins enabled+compatible carrying a capability (registry entries). */
  private async enabledWithCapability(
    cap: NormalizedPluginCapability,
  ): Promise<RegistryEntry[]> {
    const found: RegistryEntry[] = [];
    for (const entry of this.registry.values()) {
      if (!(entry.manifest.capabilities ?? []).includes(cap)) continue;
      if (!isManifestCompatible(entry.manifest)) continue;
      const row = await this.ensureInstallRow(entry);
      if (row.enabled === 1) found.push(entry);
    }
    return found;
  }

  private matchesSkillPrefix(
    manifest: SkillManifest,
    skillId: string,
  ): boolean {
    const prefixes = manifest.appliesTo?.skillPrefixes;
    if (!prefixes || prefixes.length === 0) return true;
    return prefixes.some(
      (p) => skillId === p || skillId.startsWith(`${p}.`) || skillId.startsWith(p),
    );
  }

  /**
   * Assemble a plugin's state slices + effective grants. `slices` is NOT yet
   * gated — callers exposing it (invokePlugin or the ui/data endpoint) must
   * intersect it with declared inputs + grants.
   */
  private async assembleSlices(
    id: string,
    request: unknown,
  ): Promise<{
    slices: PluginStateSlices;
    granted: Permission[];
    candidateId: string | null;
    entry: RegistryEntry;
  }> {
    const entry = this.registry.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    const row = await this.ensureInstallRow(entry);
    if (row.enabled !== 1) {
      throw new PluginError("PLUGIN_DISABLED", `plugin "${id}" is disabled`);
    }
    const granted = (row.grantedPermissions as Permission[]).filter((p) =>
      entry.manifest.permissions.includes(p),
    );

    const candidateRow = await this.ctx.store.getActiveCandidate();
    const targetRow = await this.ctx.store.getActiveTarget();
    const slices: PluginStateSlices = {};
    if (candidateRow) {
      const parsed = CandidateProfileSchema.safeParse(candidateRow.data);
      if (parsed.success) slices.candidate = parsed.data;
      slices.stories = await this.ctx.store.listStories(candidateRow.id);
      slices.resume = candidateRow.resumeText;
    }
    if (targetRow) {
      const parsed = TargetRoleSchema.safeParse(targetRow.data);
      if (parsed.success) slices.target = parsed.data;
    }
    if (candidateRow && targetRow) {
      slices.readiness = (await this.deps.graphForActive()).dimensions;
      slices.gaps = await this.deps.calculateGaps();
    }
    slices.recentEvaluations = (await this.ctx.store.listAllEvaluations())
      .slice(-20)
      .map((e) => e.data);
    slices.request = request;
    return { slices, granted, candidateId: candidateRow?.id ?? null, entry };
  }

  /**
   * v0.4: run a plugin for its output only (question/resource sources) —
   * evidenceProposals are ignored and never persisted.
   */
  async runPluginOutput(id: string, request?: unknown): Promise<unknown> {
    return (await this.invokePluginInternal(id, request)).output;
  }

  /** §9.6: run a registered plugin against its effective (manifest ∩ granted) slices. */
  async runPlugin(id: string, request?: unknown): Promise<PluginRunResult> {
    const { output, granted, candidateId } = await this.invokePluginInternal(id, request);

    const proposals = pluginEvidenceProposals(output);
    const result: PluginRunResult = {
      output,
      evidenceWritten: 0,
      evidenceIgnored: 0,
    };
    if (proposals === null) {
      result.evidenceRejected = "evidenceProposals failed schema validation";
      return result;
    }
    if (proposals.length === 0) return result;
    if (!granted.includes("evidence.write")) {
      result.evidenceIgnored = proposals.length;
      return result;
    }
    this.ctx.host.assertCan(id, "evidence.write", granted);
    const createdAt = this.ctx.iso();
    for (const p of proposals) {
      await this.ctx.registerSkillNode(p.skillId);
      await this.ctx.store.insertEvidence({
        id: newId("ev"),
        candidateId,
        skillId: p.skillId,
        type: "plugin",
        score: p.score,
        confidence: Math.min(p.confidence, PLUGIN_EVIDENCE_CONFIDENCE_CAP),
        observation: `[plugin:${id}] ${p.observation}`.slice(0, 600),
        sessionId: null,
        questionId: null,
        source: `plugin:${id}`,
        createdAt,
      });
      result.evidenceWritten += 1;
    }
    this.ctx.bumpUIEpoch();
    await this.deps.recomputeReadiness(`plugin:${id}`);
    return result;
  }

  /* ------------------------------------------------------------- v0.4 UI -- */

  private readonly uiRenderCache = new Map<
    string,
    { tree: UINode; epoch: number; at: number }
  >();
  private static readonly UI_CACHE_TTL_MS = 60_000;

  /** Test/debug hook — the epoch bump on ctx also invalidates naturally. */
  invalidateUICache(): void {
    this.uiRenderCache.clear();
  }

  /**
   * v0.4: render a declared `kind: "declarative"` contribution. The plugin runs
   * through the normal isolated path with `request = {kind:"ui", …}` and must
   * return `{ui: <tree>}`; evidenceProposals in UI runs are ignored. Trees are
   * cached per (plugin, slot|page, component, params) and invalidated by the
   * shared `ctx.uiEpoch` (readiness/evidence/target/grants) with a 60 s TTL
   * backstop. Read-only: not invoked under the orchestrator lock.
   */
  async renderPluginUI(id: string, req: PluginUIRenderRequest): Promise<UINode> {
    const entry = this.registry.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    if (!isManifestCompatible(entry.manifest)) {
      throw new PluginError(
        "PLUGIN_INCOMPATIBLE",
        `plugin "${id}" requires interview-os ${entry.manifest.engines?.["interview-os"]}`,
      );
    }
    const ui = entry.manifest.ui;
    if (!ui) {
      throw new AppError("VALIDATION", `plugin "${id}" declares no ui contributions`);
    }
    // the contribution must be declared in the manifest for this slot/page
    let kind: "declarative" | "frame" | undefined;
    if (req.page !== undefined) {
      const page = ui.pages.find(
        (p) => p.path === req.page && p.component === req.component,
      );
      kind = page?.kind;
    } else if (req.slot) {
      const list = (ui.slots as Partial<Record<PluginUISlot, { component: string; kind: string }[]>>)[
        req.slot as PluginUISlot
      ];
      kind = list?.find((x) => x.component === req.component)?.kind as
        | "declarative"
        | "frame"
        | undefined;
    }
    if (!kind) {
      throw new AppError(
        "VALIDATION",
        `plugin "${id}" does not declare component "${req.component}" for ${req.slot ? `slot "${req.slot}"` : `page "${req.page ?? ""}"`}`,
      );
    }
    if (kind !== "declarative") {
      throw new AppError(
        "VALIDATION",
        `component "${req.component}" is kind "${kind}" — only declarative contributions render via this endpoint`,
      );
    }

    const key = [
      id,
      req.slot ?? "",
      req.page ?? "",
      req.component,
      JSON.stringify(req.params ?? null),
    ].join("|");
    const hit = this.uiRenderCache.get(key);
    if (
      hit &&
      hit.epoch === this.ctx.uiEpoch &&
      Date.now() - hit.at < PluginService.UI_CACHE_TTL_MS
    ) {
      return hit.tree;
    }

    const { output } = await this.invokeHook(id, "ui.render", {
      slot: req.slot,
      component: req.component,
      page: req.page,
      params: req.params,
    });
    let tree: UINode;
    try {
      tree = validateUITree((output as { ui?: unknown })?.ui, { pluginId: id });
    } catch (err) {
      throw new PluginError(
        "PLUGIN_OUTPUT",
        `plugin "${id}" returned an invalid ui tree: ${
          err instanceof Error ? err.message.slice(0, 300) : String(err)
        }`,
      );
    }
    this.uiRenderCache.set(key, { tree, epoch: this.ctx.uiEpoch, at: Date.now() });
    return tree;
  }

  /** v0.4: UI contributions of every enabled + compatible plugin. */
  async listUIContributions(): Promise<PluginUIContributionView[]> {
    const views: PluginUIContributionView[] = [];
    for (const entry of this.registry.values()) {
      if (!isManifestCompatible(entry.manifest)) continue;
      const row = await this.ensureInstallRow(entry);
      if (row.enabled !== 1) continue;
      const { manifest } = entry;
      if (!manifest.ui && !(manifest.interviewModes ?? []).length) continue;
      views.push({
        pluginId: manifest.id,
        pluginName: manifest.name ?? manifest.id,
        navigation: manifest.ui?.navigation ?? [],
        commands: manifest.ui?.commands ?? [],
        slots: manifest.ui?.slots ?? {},
        pages: manifest.ui?.pages ?? [],
        interviewModes: manifest.interviewModes ?? [],
      });
    }
    return views;
  }

  /**
   * v0.4 Level 2: resolve a `kind: "frame"` contribution — either a slot
   * component or a declared page — to its on-disk entry file. Enabled +
   * compatible only; the path itself was validated at manifest load.
   */
  async resolveUIFrame(
    id: string,
    sel: { component?: string; page?: string },
  ): Promise<{ dir: string; entry: string; component: string; page?: string; title?: string }> {
    const entry = this.registry.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    const row = await this.ensureInstallRow(entry);
    if (row.enabled !== 1) {
      throw new PluginError("PLUGIN_DISABLED", `plugin "${id}" is disabled`);
    }
    if (!isManifestCompatible(entry.manifest)) {
      throw new PluginError(
        "PLUGIN_INCOMPATIBLE",
        `plugin "${id}" requires interview-os ${entry.manifest.engines?.["interview-os"]}`,
      );
    }
    const ui = entry.manifest.ui;
    let found:
      | { component: string; kind: string; entry?: string; title?: string }
      | undefined;
    if (sel.page !== undefined) {
      const p = ui?.pages.find(
        (x) => x.path === sel.page && (sel.component === undefined || x.component === sel.component),
      );
      found = p
        ? { component: p.component, kind: p.kind, entry: p.entry, title: p.title }
        : undefined;
    } else if (sel.component !== undefined) {
      for (const list of Object.values(ui?.slots ?? {})) {
        found = (list as { component: string; kind: string; entry?: string; title?: string }[]).find(
          (x) => x.component === sel.component,
        );
        if (found) break;
      }
    }
    if (!found || found.kind !== "frame" || !found.entry || !entry.dir) {
      throw new AppError(
        "NOT_FOUND",
        `plugin "${id}" declares no frame contribution for ${
          sel.page !== undefined ? `page "${sel.page}"` : `component "${sel.component ?? ""}"`
        }`,
      );
    }
    return {
      dir: entry.dir,
      entry: found.entry,
      component: found.component,
      page: sel.page,
      title: found.title,
    };
  }

  /** v0.4: the on-disk ui/ dir of an enabled + compatible plugin (assets). */
  async resolveUIAssetDir(id: string): Promise<string> {
    const entry = this.registry.get(id);
    if (!entry || !entry.dir) {
      throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    }
    const row = await this.ensureInstallRow(entry);
    if (row.enabled !== 1) {
      throw new PluginError("PLUGIN_DISABLED", `plugin "${id}" is disabled`);
    }
    if (!isManifestCompatible(entry.manifest)) {
      throw new PluginError(
        "PLUGIN_INCOMPATIBLE",
        `plugin "${id}" requires interview-os ${entry.manifest.engines?.["interview-os"]}`,
      );
    }
    return path.join(entry.dir, "ui");
  }

  /**
   * v0.4 Level 2: the plugin's declared + granted state slices for a frame
   * (same gating as a plugin run — the browser never assembles these itself).
   */
  async pluginUIData(
    id: string,
    sel: { component?: string; page?: string },
  ): Promise<Record<string, unknown>> {
    await this.resolveUIFrame(id, sel);
    const { slices, granted, entry } = await this.assembleSlices(id, {
      kind: "ui-frame",
      component: sel.component,
      page: sel.page,
    });
    const grantedSet = new Set(granted);
    const out: Record<string, unknown> = {};
    for (const input of entry.manifest.inputs) {
      if (grantedSet.has(input.permission)) {
        out[input.key] = slices[input.key as keyof PluginStateSlices];
      }
    }
    // v1: frame components see the same settings handlers get (ctx.settings)
    out.settings = await this.getPluginSettings(id);
    return out;
  }

  /**
   * v0.4 Level 2: stateless plugin invocation from a frame. The plugin sees
   * `request = { kind: "ui-frame", component, page, request }`; evidence
   * proposals are ignored; a `ui` field is validated as a declarative tree.
   */
  async pluginUIRun(
    id: string,
    sel: { component?: string; page?: string; request?: unknown },
  ): Promise<{ output: unknown; ui?: UINode }> {
    const frame = await this.resolveUIFrame(id, sel);
    const { output } = await this.invokeHook(id, "ui.frameRun", {
      component: frame.component,
      page: frame.page,
      request: sel.request,
    });
    // Contract response is { output, ui? }; legacy plugins return their raw
    // output, which stays the `output` value (with `ui` extracted as before).
    const obj = output as { output?: unknown; ui?: unknown } | null;
    const isEnvelope =
      obj !== null && typeof obj === "object" && "output" in obj;
    const result: { output: unknown; ui?: UINode } = {
      output: isEnvelope ? obj.output : output,
    };
    const ui = (isEnvelope ? obj : output as { ui?: unknown } | null)?.ui;
    if (ui !== undefined) {
      try {
        result.ui = validateUITree(ui, { pluginId: id });
      } catch {
        /* invalid ui trees are simply not forwarded to the frame */
      }
    }
    return result;
  }

  /** v0.4: resolve "<pluginId>:<modeId>" to a declared plugin interview mode. */
  async pluginInterviewMode(
    pluginModeId: string,
  ): Promise<{ pluginId: string; mode: PluginInterviewMode }> {
    const idx = pluginModeId.indexOf(":");
    if (idx <= 0) {
      throw new AppError(
        "VALIDATION",
        `pluginModeId must be "<pluginId>:<modeId>" (got "${pluginModeId}")`,
      );
    }
    const pluginId = pluginModeId.slice(0, idx);
    const modeId = pluginModeId.slice(idx + 1);
    const entry = this.registry.get(pluginId);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${pluginId}"`);
    const mode = (entry.manifest.interviewModes ?? []).find((m) => m.id === modeId);
    if (!mode) {
      throw new AppError(
        "VALIDATION",
        `plugin "${pluginId}" declares no interview mode "${modeId}"`,
      );
    }
    const row = await this.ensureInstallRow(entry);
    if (row.enabled !== 1) {
      throw new PluginError("PLUGIN_DISABLED", `plugin "${pluginId}" is disabled`);
    }
    if (!isManifestCompatible(entry.manifest)) {
      throw new PluginError(
        "PLUGIN_INCOMPATIBLE",
        `plugin "${pluginId}" requires interview-os ${entry.manifest.engines?.["interview-os"]}`,
      );
    }
    return { pluginId, mode };
  }

  /**
   * §4: sync plugin-shipped packs into the PackRegistry — enabled+compatible
   * plugins with pack capabilities only. Called after load, enable/disable,
   * install and uninstall.
   */
  async syncPluginPacks(): Promise<void> {
    const dirs: { id: string; dir: string }[] = [];
    for (const entry of this.registry.values()) {
      if (!entry.dir) continue;
      const caps = entry.manifest.capabilities ?? [];
      if (!caps.includes("company_pack") && !caps.includes("role_pack")) {
        continue;
      }
      if (!isManifestCompatible(entry.manifest)) continue;
      const row = await this.ensureInstallRow(entry);
      if (row.enabled === 1) dirs.push({ id: entry.manifest.id, dir: entry.dir });
    }
    this.ctx.packs.setPluginDirs(dirs);
    this.ctx.packs.reload();
  }

  async findPluginsByCapability(cap: NormalizedPluginCapability): Promise<SkillManifest[]> {
    const found: SkillManifest[] = [];
    for (const entry of this.registry.values()) {
      if (!(entry.manifest.capabilities ?? []).includes(cap)) continue;
      if (!isManifestCompatible(entry.manifest)) continue;
      const row = await this.ensureInstallRow(entry);
      if (row.enabled === 1) found.push(entry.manifest);
    }
    return found;
  }

  /** Ids of enabled + compatible plugins carrying a capability. */
  async enabledCapabilityIds(cap: NormalizedPluginCapability): Promise<string[]> {
    return (await this.findPluginsByCapability(cap)).map((m) => m.id);
  }

  private requireDirs(): PluginDirs {
    if (!this.deps.pluginDirs) {
      throw new AppError(
        "PLUGIN_INSTALL",
        "plugin install/uninstall requires configured plugin directories",
      );
    }
    return this.deps.pluginDirs;
  }

  /** Install a plugin from a git remote (https) or a local git checkout path. */
  async installPluginFromGit(url: string): Promise<PluginView> {
    const dirs = this.requireDirs();
    validateGitSource(url);
    const isLocal = path.isAbsolute(url);

    await fs.mkdir(dirs.installed, { recursive: true });
    const tmpDir = path.join(
      dirs.installed,
      `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      await cloneShallow(url, tmpDir);
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      throw err;
    }

    try {
      const manifest = await loadManifestFile(tmpDir);
      if (this.registry.has(manifest.id) || this.ctx.host.manifests().some((m) => m.id === manifest.id)) {
        throw new AppError(
          "PLUGIN_INSTALL",
          `a skill or plugin with id "${manifest.id}" already exists`,
        );
      }
      const entryFile = await findEntryFile(tmpDir);
      if (!entryFile) {
        throw new AppError("PLUGIN_INSTALL", `plugin "${manifest.id}" has no index.ts/index.js entry`);
      }
      const dest = path.join(dirs.installed, manifest.id);
      await fs.rm(path.join(tmpDir, ".git"), { recursive: true, force: true });
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(tmpDir, dest);

      await this.ctx.store.upsertPluginInstall({
        id: manifest.id,
        enabled: 0,
        grantedPermissions: [],
        source: "git",
        sourceUrl: isLocal ? null : url,
        dirName: manifest.id,
        installedAt: this.ctx.iso(),
        updatedAt: this.ctx.iso(),
      });
      this.registerPlugin(
        manifest,
        createIsolatedExecutor({
          pluginDir: dest,
          entryFile,
          manifest,
          logger: this.ctx.logger,
        }),
        { dir: dest, entryFile, source: "git" },
      );
      if (manifest.taxonomy?.length) {
        taxonomy.registerNodes(manifest.taxonomy);
        for (const node of manifest.taxonomy) {
          await this.ctx.registerSkillNode(node.id);
        }
      }
      this.ctx.logger.info("plugin.installed", { plugin: manifest.id });
      this.ctx.bumpUIEpoch();
      await this.syncPluginPacks();
      const view = (await this.listPlugins()).find((v) => v.manifest.id === manifest.id);
      if (!view) throw new AppError("INTERNAL", "installed plugin missing");
      return view;
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (err instanceof AppError) throw err;
      throw new AppError(
        "PLUGIN_INSTALL",
        `invalid plugin: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  }

  /** Remove a git-installed plugin; bundled plugins cannot be uninstalled. */
  async uninstallPlugin(id: string): Promise<void> {
    this.requireDirs();
    const entry = this.registry.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    const row = await this.ctx.store.getPluginInstall(id);
    const source = row?.source ?? entry.source;
    if (source !== "git") {
      throw new AppError(
        "VALIDATION",
        `plugin "${id}" is bundled and cannot be uninstalled`,
      );
    }
    if (entry.dir) {
      await fs.rm(entry.dir, { recursive: true, force: true });
    }
    await this.ctx.store.deletePluginInstall(id);
    this.ctx.host.unregister(id);
    this.registry.delete(id);
    this.ctx.logger.info("plugin.uninstalled", { plugin: id });
    this.ctx.bumpUIEpoch();
    await this.syncPluginPacks();
  }

  /* ------------------------------------------- §3 plugin settings + storage */

  private entryFor(id: string): RegistryEntry {
    const entry = this.registry.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown plugin "${id}"`);
    return entry;
  }

  /** Declared settings fields (manifest `settings`, ≤ 20). */
  pluginSettingsSpec(id: string): PluginSettingField[] {
    return this.entryFor(id).manifest.settings ?? [];
  }

  /** Effective settings: declared defaults overlaid with stored values. */
  async getPluginSettings(id: string): Promise<Record<string, unknown>> {
    const fields = this.pluginSettingsSpec(id);
    const stored = await this.ctx.store.getPluginSettings(id);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      out[f.key] = stored[f.key] ?? f.default ?? null;
    }
    return out;
  }

  /** PUT: validate each value against the declared field; unknown keys rejected. */
  async setPluginSettings(
    id: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fields = this.pluginSettingsSpec(id);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    for (const [key, value] of Object.entries(values)) {
      const field = byKey.get(key);
      if (!field) {
        throw new AppError(
          "VALIDATION",
          `plugin "${id}" declares no setting "${key}"`,
        );
      }
      const err = settingValueError(field, value);
      if (err) {
        throw new AppError("VALIDATION", `setting "${key}": ${err}`);
      }
      await this.ctx.store.setPluginSetting(id, key, value);
    }
    return this.getPluginSettings(id);
  }

  private static readonly STORAGE_KEY_MAX = 128;
  private static readonly STORAGE_VALUE_MAX = 32 * 1024;
  private static readonly STORAGE_TOTAL_MAX = 256 * 1024;

  /**
   * Plugin-owned KV storage adapter handed to runs (as ctx.storage and via
   * IPC to isolated runners). Plugin-private: not readable by other plugins,
   * wiped on uninstall, excluded from exports. No permission needed.
   */
  private storageFor(id: string): PluginKvStorage {
    const store = this.ctx.store;
    const checkKey = (key: unknown): string => {
      if (
        typeof key !== "string" ||
        key.length === 0 ||
        key.length > PluginService.STORAGE_KEY_MAX
      ) {
        throw new AppError(
          "VALIDATION",
          `storage keys must be 1–${PluginService.STORAGE_KEY_MAX} chars`,
        );
      }
      return key;
    };
    return {
      get: async (key: string) => store.getPluginStorageValue(id, checkKey(key)),
      set: async (key: string, value: unknown) => {
        checkKey(key);
        let size: number;
        try {
          size = JSON.stringify(value).length;
        } catch {
          throw new AppError("VALIDATION", "storage values must be JSON-serializable");
        }
        if (size > PluginService.STORAGE_VALUE_MAX) {
          throw new AppError(
            "VALIDATION",
            `storage values are capped at ${PluginService.STORAGE_VALUE_MAX / 1024} KB`,
          );
        }
        const used = await store.pluginStorageBytes(id);
        const existing = await store.getPluginStorageValue(id, key);
        const existingSize =
          existing === undefined ? 0 : JSON.stringify(existing).length;
        if (used - existingSize + size > PluginService.STORAGE_TOTAL_MAX) {
          throw new AppError(
            "VALIDATION",
            `plugin storage is capped at ${PluginService.STORAGE_TOTAL_MAX / 1024} KB`,
          );
        }
        await store.setPluginStorageValue(id, key, value);
      },
      delete: async (key: string) => {
        await store.deletePluginStorageValue(id, checkKey(key));
      },
    };
  }

  /* ------------------------------------------ §2 evaluation.review -------- */

  /**
   * After the built-in evaluation persists, ask enabled `evaluation` plugins
   * (manifest `appliesTo.skillPrefixes` matched against the question skill)
   * for review observations. The answer text only reaches plugins granted
   * `answers.read`. Plugins run in parallel, 10 s each; failures are logged
   * and skipped. Read-only w.r.t. core state — proposals are returned for the
   * caller to persist under the lock.
   */
  async evaluationReviews(args: {
    question: HookRequest<"evaluation.review">["question"];
    evaluation: AnswerEvaluation;
    answer: { text: string; code?: string; language?: string };
  }): Promise<PluginReview[]> {
    const plugins = await this.enabledWithCapability("evaluation");
    const candidates = plugins.filter((e) =>
      this.matchesSkillPrefix(e.manifest, args.question.skillId),
    );
    if (candidates.length === 0) return [];

    const reviews = await Promise.all(
      candidates.map(async (entry): Promise<PluginReview | null> => {
        const id = entry.manifest.id;
        const row = await this.ensureInstallRow(entry);
        const granted = (row.grantedPermissions as Permission[]).filter((p) =>
          entry.manifest.permissions.includes(p),
        );
        const req: HookRequest<"evaluation.review"> = {
          question: args.question,
          evaluation: args.evaluation,
          answer:
            granted.includes("answers.read") &&
            entry.manifest.permissions.includes("answers.read")
              ? {
                  text: args.answer.text.slice(0, 50_000),
                  code: args.answer.code?.slice(0, 100_000) ?? null,
                  language: args.answer.language ?? null,
                }
              : null,
        };
        try {
          const { output } = await withTimeout(
            this.invokeHook(id, "evaluation.review", req),
            10_000,
            `plugin "${id}" evaluation.review`,
          );
          const res = output as HookResponse<"evaluation.review">;
          return {
            pluginId: id,
            pluginName: entry.manifest.name ?? id,
            observations: res.observations ?? [],
            evidenceProposals: res.evidenceProposals ?? [],
            evidenceGranted: granted.includes("evidence.write"),
          };
        } catch (err) {
          this.ctx.logger.warn("plugin.review_failed", {
            plugin: id,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
          });
          return null;
        }
      }),
    );
    return reviews.filter((r): r is PluginReview => r !== null);
  }

  /* ------------------------------------------ §2 preparation.suggest ------ */

  /** Plugin-suggested prep activities (read-only; accepting is separate). */
  async pluginPrepSuggestions(): Promise<PluginPrepSuggestionGroup[]> {
    const plugins = await this.enabledWithCapability("preparation");
    if (plugins.length === 0) return [];
    let gaps: Gap[] = [];
    let skillIds: string[] = [];
    try {
      gaps = await this.deps.calculateGaps();
      skillIds = gaps.map((g) => g.skillId);
    } catch {
      /* no active candidate/target — plugins still get an empty context */
    }
    const groups = await Promise.all(
      plugins.map(async (entry): Promise<PluginPrepSuggestionGroup | null> => {
        const id = entry.manifest.id;
        try {
          const { output } = await withTimeout(
            this.invokeHook(id, "preparation.suggest", {
              gaps: gaps.slice(0, 10),
              skillIds,
            }),
            10_000,
            `plugin "${id}" preparation.suggest`,
          );
          const res = output as HookResponse<"preparation.suggest">;
          return {
            pluginId: id,
            pluginName: entry.manifest.name ?? id,
            activities: res.activities ?? [],
          };
        } catch (err) {
          this.ctx.logger.warn("plugin.prep_suggest_failed", {
            plugin: id,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
          });
          return null;
        }
      }),
    );
    return groups.filter((g): g is PluginPrepSuggestionGroup => g !== null);
  }

  /**
   * Persist an accepted suggestion as a prep action (`source: "plugin:<id>"`).
   * The user's click is the consent — no write permission needed. Re-validated
   * against the contract before insert. Caller wraps in the orchestrator lock.
   */
  async acceptPluginSuggestion(
    pluginId: string,
    activity: unknown,
  ): Promise<{ id: string }> {
    this.entryFor(pluginId); // 404 unknown
    const parsed = PluginPrepActivitySchema.safeParse(activity);
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION",
        `activity does not match the preparation.suggest contract`,
      );
    }
    const a = parsed.data;
    const candidate = await this.ctx.store.getActiveCandidate();
    const target = await this.ctx.store.getActiveTarget();
    if (!candidate || !target) {
      throw new AppError("VALIDATION", "no active candidate/target");
    }
    const row = {
      id: newId("action"),
      skillId: a.skillId,
      targetId: target.id,
      priority: 0,
      reason: `Suggested by plugin ${pluginId}`,
      action: `${a.title} — ${a.action}`.slice(0, 1000),
      successCriteria: a.successCriteria,
      status: "open",
      severity: "medium",
      createdAt: this.ctx.iso(),
      sourceEvidenceIds: [],
      resources: [],
      source: `plugin:${pluginId}`,
    };
    await this.ctx.store.insertAction(row);
    this.ctx.logger.info("state.mutated", {
      entity: "prep_action",
      id: row.id,
      source: `plugin:${pluginId}`,
    });
    return { id: row.id };
  }

  /* ------------------------------------------ §2 lifecycle events --------- */

  /**
   * Fire a lifecycle event hook at subscribed plugins — called by the
   * orchestrator AFTER its locked work resolves. Runs sequentially per
   * plugin, fire-and-forget; returned evidence proposals must be persisted
   * by the caller under the lock via `persistPluginEvidence`.
   */
  async firePluginEvent(
    name: "events.sessionCompleted" | "events.readinessUpdated",
    payload: unknown,
  ): Promise<{ pluginId: string; proposals: unknown[] }[]> {
    const results: { pluginId: string; proposals: unknown[] }[] = [];
    const short = name.replace(/^events\./, "");
    for (const entry of this.registry.values()) {
      if (!(entry.manifest.events ?? []).includes(short as never)) continue;
      if (!isManifestCompatible(entry.manifest)) continue;
      const row = await this.ensureInstallRow(entry);
      if (row.enabled !== 1) continue;
      const id = entry.manifest.id;
      try {
        const { output } = await withTimeout(
          this.invokeHook(id, name, payload),
          10_000,
          `plugin "${id}" ${name}`,
        );
        const proposals = (output as { evidenceProposals?: unknown[] })
          ?.evidenceProposals;
        if (Array.isArray(proposals) && proposals.length > 0) {
          results.push({ pluginId: id, proposals });
        }
      } catch (err) {
        this.ctx.logger.warn("plugin.event_failed", {
          plugin: id,
          event: name,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Persist event/review evidence proposals through the standard gate:
   * schema-validated, `evidence.write` required, confidence-capped, type
   * `plugin` with plugin source. Called under the orchestrator lock.
   */
  async persistPluginEvidence(
    id: string,
    proposals: unknown[],
  ): Promise<{ written: number; ignored: number }> {
    const parsed = pluginEvidenceProposals({ evidenceProposals: proposals });
    if (parsed === null || parsed.length === 0) {
      return { written: 0, ignored: proposals.length };
    }
    const entry = this.entryFor(id);
    const row = await this.ensureInstallRow(entry);
    const granted = (row.grantedPermissions as Permission[]).filter((p) =>
      entry.manifest.permissions.includes(p),
    );
    if (!granted.includes("evidence.write")) {
      return { written: 0, ignored: parsed.length };
    }
    this.ctx.host.assertCan(id, "evidence.write", granted);
    const candidate = await this.ctx.store.getActiveCandidate();
    const createdAt = this.ctx.iso();
    let written = 0;
    for (const p of parsed) {
      await this.ctx.registerSkillNode(p.skillId);
      await this.ctx.store.insertEvidence({
        id: newId("ev"),
        candidateId: candidate?.id ?? null,
        skillId: p.skillId,
        type: "plugin",
        score: p.score,
        confidence: Math.min(p.confidence, PLUGIN_EVIDENCE_CONFIDENCE_CAP),
        observation: `[plugin:${id}] ${p.observation}`.slice(0, 600),
        sessionId: null,
        questionId: null,
        source: `plugin:${id}`,
        createdAt,
      });
      written += 1;
    }
    if (written > 0) this.ctx.bumpUIEpoch();
    return { written, ignored: 0 };
  }
}

/* ---------------------------------------------------------- helpers ------- */

export interface PluginReview {
  pluginId: string;
  pluginName: string;
  observations: PluginReviewObservation[];
  evidenceProposals: unknown[];
  evidenceGranted: boolean;
}

export interface PluginPrepSuggestionGroup {
  pluginId: string;
  pluginName: string;
  activities: PluginPrepActivity[];
}

function settingValueError(
  field: PluginSettingField,
  value: unknown,
): string | null {
  switch (field.type) {
    case "string":
      return typeof value === "string" && value.length <= 1000
        ? null
        : "must be a string (≤ 1000 chars)";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "must be a finite number";
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean";
    case "enum":
      return typeof value === "string" &&
        (field.options ?? []).includes(value)
        ? null
        : `must be one of ${(field.options ?? []).join(", ")}`;
    default:
      return "unknown setting type";
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new PluginError("PLUGIN_TIMEOUT", `${label} exceeded ${ms / 1000}s`)), ms),
  );
  try {
    return await Promise.race([p, timeout]);
  } finally {
    timeout.catch(() => {});
  }
}
