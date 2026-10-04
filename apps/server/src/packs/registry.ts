import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  AppError,
  COMPANY_PROFILES,
  compileCompanyPack,
  CompanyPackOverlaySchema,
  CompanyPackSchema,
  checkOverlayProvenance,
  InterviewPackSchema,
  matchProfileIn,
  RolePackSchema,
  SLUG_ID_REGEX,
  taxonomy,
  type CompanyPackOverlay,
  type CompanyPackWithOverlays,
  type CompanyProfile,
  type InterviewPack,
  type ModeId,
  type PrepResource,
  type QuestionCandidate,
  type RolePack,
  type SkillId,
} from "@interview-os/core";
import type { Logger } from "@interview-os/core";
import { cloneShallow, validateGitSource } from "../adapters/git.js";

export interface PackLoadError {
  dir: string;
  file: string;
  error: string;
}

export type PackSourceKind = "bundled" | "installed" | `plugin:${string}`;

export interface CompanyPackEntry {
  pack: CompanyPackWithOverlays;
  profile: CompanyProfile;
  source: PackSourceKind;
  dir: string;
}

export interface RolePackEntry {
  pack: RolePack;
  source: PackSourceKind;
  dir: string;
}

export interface InterviewPackEntry {
  pack: InterviewPack;
  source: "bundled";
}

const PACK_KIND_DIRS = { company: "companies", role: "roles" } as const;
export type InstallablePackKind = keyof typeof PACK_KIND_DIRS;

function matchesSkill(qSkill: string, skillId: SkillId): boolean {
  return qSkill === skillId || qSkill.startsWith(`${skillId}.`);
}

function compatibleMode(mode: ModeId | undefined, roundType: string): boolean {
  return !mode || mode === roundType || roundType === "mixed";
}

/**
 * Loads bundled + installed packs (company dirs, role dirs, interview YAML
 * files), compiles company profiles, and answers pack lookups. With no dirs
 * configured it degrades to built-ins only. `ready()` must be awaited once
 * before sync lookups are used; it is idempotent.
 */
export class PackRegistry {
  private readonly companyPacks = new Map<string, CompanyPackEntry>();
  private readonly rolePacks = new Map<string, RolePackEntry>();
  private readonly interviewPacks = new Map<string, InterviewPackEntry>();
  readonly loadErrors: PackLoadError[] = [];
  private loaded = false;

  constructor(
    private readonly dirs: { bundled?: string; installed?: string },
    private readonly logger?: Logger,
  ) {}

  /**
   * Load (or reload) all pack directories; safe to call repeatedly. Loads are
   * synchronous filesystem reads so pack lookups can stay sync for callers.
   */
  ready(): Promise<void> {
    if (!this.loaded) {
      this.loadAll();
      this.loaded = true;
    }
    return Promise.resolve();
  }

  /** Synchronous ensure-loaded for the sync lookup methods below. */
  ensureLoaded(): void {
    if (!this.loaded) {
      this.loadAll();
      this.loaded = true;
    }
  }

  private fail(errors: PackLoadError[], dir: string, file: string, err: unknown): void {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    errors.push({ dir, file, error });
    this.logger?.warn("pack.load_failed", { dir, file, error });
  }

  private loadAll(): void {
    this.companyPacks.clear();
    this.rolePacks.clear();
    this.interviewPacks.clear();
    this.loadErrors.length = 0;
    const { bundled, installed } = this.dirs;
    if (bundled) this.loadTree(bundled, "bundled");
    if (installed) this.loadTree(installed, "installed");
    // v1: enabled plugins may ship packs/ under their plugin dir; tagged
    // source `plugin:<id>` and id collisions are load errors for that pack.
    for (const p of this.pluginDirs) {
      this.loadTree(path.join(p.dir, "packs"), `plugin:${p.id}`);
    }
    // role packs may add taxonomy nodes — register once everything is loaded
    for (const { pack } of this.rolePacks.values()) {
      if (pack.taxonomy.length > 0) taxonomy.registerNodes(pack.taxonomy);
    }
  }

  /**
   * Plugin pack dirs currently in effect — set by PluginService.syncPluginPacks
   * (enabled + compatible plugins with pack capabilities only), then reload().
   */
  private pluginDirs: { id: string; dir: string }[] = [];

  setPluginDirs(dirs: { id: string; dir: string }[]): void {
    this.pluginDirs = dirs;
  }

  /** Reload all pack sources (e.g. after plugin enable/disable/uninstall). */
  reload(): void {
    this.loadAll();
    this.loaded = true;
  }

  private loadTree(root: string, source: PackSourceKind): void {
    this.loadCompanyDir(path.join(root, PACK_KIND_DIRS.company), source);
    this.loadRoleDir(path.join(root, PACK_KIND_DIRS.role), source);
    if (source === "bundled") {
      this.loadInterviewDir(path.join(root, "interview"));
    }
  }

  private subdirs(dir: string): string[] {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  }

  private loadCompanyDir(root: string, source: PackSourceKind): void {
    for (const name of this.subdirs(root)) {
      const dir = path.join(root, name);
      let files;
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => !f.startsWith(".") && (f.endsWith(".yaml") || f.endsWith(".yml")));
      } catch (err) {
        this.fail(this.loadErrors, `${PACK_KIND_DIRS.company}/${name}`, "company.yaml", err);
        continue;
      }
      const baseFile = files.find((f) => f === "company.yaml" || f === "company.yml");
      if (!baseFile) {
        this.fail(this.loadErrors, `${PACK_KIND_DIRS.company}/${name}`, "company.yaml",
          "company pack is missing company.yaml");
        continue;
      }
      try {
        const raw = YAML.parse(fs.readFileSync(path.join(dir, baseFile), "utf8"));
        const pack = CompanyPackSchema.parse(raw);
        if (COMPANY_PROFILES.some((p) => p.id === pack.id)) {
          throw new Error(`company pack id "${pack.id}" collides with a built-in profile`);
        }
        if (source.startsWith("plugin:") && this.companyPacks.has(pack.id)) {
          throw new Error(`company pack id "${pack.id}" collides with an existing pack`);
        }
        const overlays: CompanyPackOverlay[] = [];
        for (const f of files) {
          if (f === baseFile) continue;
          const stem = f.replace(/\.ya?ml$/, "");
          const overlayRaw = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          const overlay = { ...CompanyPackOverlaySchema.parse(overlayRaw), id: stem };
          checkOverlayProvenance(overlay, pack.sources);
          overlays.push(overlay);
        }
        const full: CompanyPackWithOverlays = { ...pack, overlays };
        this.companyPacks.set(pack.id, {
          pack: full,
          profile: compileCompanyPack(full),
          source,
          dir,
        });
      } catch (err) {
        this.fail(this.loadErrors, `${PACK_KIND_DIRS.company}/${name}`, baseFile, err);
      }
    }
  }

  private loadRoleDir(root: string, source: PackSourceKind): void {
    for (const name of this.subdirs(root)) {
      const dir = path.join(root, name);
      const file = path.join(dir, "role.yaml");
      try {
        const raw = YAML.parse(fs.readFileSync(file, "utf8"));
        const pack = RolePackSchema.parse(raw);
        if (pack.id !== name) {
          throw new Error(`role pack id "${pack.id}" does not match directory "${name}"`);
        }
        if (source.startsWith("plugin:") && this.rolePacks.has(pack.id)) {
          throw new Error(`role pack id "${pack.id}" collides with an existing pack`);
        }
        this.rolePacks.set(pack.id, { pack, source, dir });
      } catch (err) {
        this.fail(this.loadErrors, `${PACK_KIND_DIRS.role}/${name}`, "role.yaml", err);
      }
    }
  }

  private loadInterviewDir(root: string): void {
    let files;
    try {
      files = fs.readdirSync(root).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const raw = YAML.parse(fs.readFileSync(path.join(root, f), "utf8"));
        const pack = InterviewPackSchema.parse(raw);
        this.interviewPacks.set(pack.id, { pack, source: "bundled" });
      } catch (err) {
        this.fail(this.loadErrors, `interview/${f}`, f, err);
      }
    }
  }

  // ------------------------------------------------------------------ lookups

  /** Built-in + pack-compiled company profiles. */
  listCompanyProfiles(): CompanyProfile[] {
    this.ensureLoaded();
    return [
      ...COMPANY_PROFILES,
      ...[...this.companyPacks.values()].map((e) => e.profile),
    ];
  }

  companyProfile(id: string): CompanyProfile {
    this.ensureLoaded();
    return (
      COMPANY_PROFILES.find((p) => p.id === id) ??
      this.companyPacks.get(id)?.profile ??
      COMPANY_PROFILES.find((p) => p.id === "generic")!
    );
  }

  matchCompanyProfile(companyName: string): CompanyProfile {
    return matchProfileIn(this.listCompanyProfiles(), companyName);
  }

  companyPack(id: string): CompanyPackWithOverlays | undefined {
    this.ensureLoaded();
    return this.companyPacks.get(id)?.pack;
  }

  listCompanyPacks(): CompanyPackEntry[] {
    this.ensureLoaded();
    return [...this.companyPacks.values()];
  }

  rolePack(id: string): RolePack | undefined {
    this.ensureLoaded();
    return this.rolePacks.get(id)?.pack;
  }

  listRolePacks(): RolePackEntry[] {
    this.ensureLoaded();
    return [...this.rolePacks.values()];
  }

  listInterviewPacks(): InterviewPack[] {
    this.ensureLoaded();
    return [...this.interviewPacks.values()].map((e) => e.pack);
  }

  bundledInterviewPack(id: string): InterviewPack | undefined {
    this.ensureLoaded();
    return this.interviewPacks.get(id)?.pack;
  }

  installedPackDir(kind: InstallablePackKind): string | undefined {
    return this.dirs.installed
      ? path.join(this.dirs.installed, PACK_KIND_DIRS[kind])
      : undefined;
  }

  /**
   * Clone a pack repo into a temp dir under installed/<kind>s, validate it,
   * rename to <id>, and reload the registry. Returns the pack id.
   */
  async installPackFromGit(kind: InstallablePackKind, url: string): Promise<{ id: string }> {
    const installedRoot = this.installedPackDir(kind);
    if (!installedRoot) {
      throw new AppError("PACK_INSTALL", "pack install requires configured pack directories");
    }
    validateGitSource(url, "PACK_INSTALL");
    await fsp.mkdir(installedRoot, { recursive: true });
    const tmpDir = path.join(
      installedRoot,
      `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      await cloneShallow(url, tmpDir, "PACK_INSTALL");
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      throw err;
    }
    try {
      let id: string;
      if (kind === "company") {
        const raw = YAML.parse(fs.readFileSync(path.join(tmpDir, "company.yaml"), "utf8"));
        id = CompanyPackSchema.parse(raw).id;
      } else {
        const raw = YAML.parse(fs.readFileSync(path.join(tmpDir, "role.yaml"), "utf8"));
        id = RolePackSchema.parse(raw).id;
      }
      if (!SLUG_ID_REGEX.test(id)) throw new Error(`invalid pack id "${id}"`);
      const dest = path.join(installedRoot, id);
      await fsp.rm(path.join(tmpDir, ".git"), { recursive: true, force: true });
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(tmpDir, dest);
      this.loadAll();
      if (kind === "company" ? !this.companyPacks.has(id) : !this.rolePacks.has(id)) {
        const err = this.loadErrors.find((e) => e.dir.endsWith(`/${id}`) || e.dir.endsWith(`\\${id}`));
        throw new AppError(
          "PACK_INSTALL",
          `pack "${id}" failed to load${err ? `: ${err.error}` : ""}`,
        );
      }
      this.logger?.info("pack.installed", { pack: id, kind });
      return { id };
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      if (err instanceof AppError) throw err;
      throw new AppError(
        "PACK_INSTALL",
        `invalid pack: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  }

  /** Remove an installed pack; bundled packs cannot be removed. */
  async uninstallPack(kind: InstallablePackKind, id: string): Promise<void> {
    const entry = kind === "company" ? this.companyPacks.get(id) : this.rolePacks.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown ${kind} pack "${id}"`);
    if (entry.source !== "installed") {
      throw new AppError("VALIDATION", `pack "${id}" is bundled and cannot be uninstalled`);
    }
    await fsp.rm(entry.dir, { recursive: true, force: true });
    this.companyPacks.delete(id);
    this.rolePacks.delete(id);
    this.logger?.info("pack.uninstalled", { pack: id, kind });
  }

  // --------------------------------------------------------- question sources

  private packQuestions(
    questions: { skillId: string; text: string; difficulty?: "easy" | "medium" | "hard"; mode?: ModeId; provenance: "sourced" | "community" }[],
    skillId: SkillId,
    roundType: string,
    kind: QuestionCandidate["source"]["kind"],
    id: string,
  ): QuestionCandidate[] {
    return questions
      .filter((q) => matchesSkill(q.skillId, skillId) && compatibleMode(q.mode, roundType))
      .map((q) => ({
        skillId: q.skillId as SkillId,
        text: q.text,
        difficulty: q.difficulty,
        mode: q.mode,
        source: { kind, id, provenance: q.provenance },
      }));
  }

  /** Overlays matching a target role/round apply on top of the base pack. */
  overlayApplies(overlay: CompanyPackOverlay, role: string, roundType?: string): boolean {
    const { roleKeywords, mode } = overlay.appliesTo;
    const roleHit = roleKeywords.some((kw) =>
      role.toLowerCase().includes(kw.toLowerCase()),
    );
    const modeHit = mode !== undefined && roundType !== undefined && mode === roundType;
    return roleHit || modeHit;
  }

  /**
   * Question candidates from a company profile's pack — overlay questions
   * (matching role/mode) first, then base pack questions.
   */
  companyPackQuestions(
    companyProfileId: string,
    skillId: SkillId,
    roundType: string,
    role: string,
  ): QuestionCandidate[] {
    this.ensureLoaded();
    const entry = this.companyPacks.get(companyProfileId);
    if (!entry) return [];
    const overlayQuestions = entry.pack.overlays
      .filter((o) => this.overlayApplies(o, role, roundType))
      .flatMap((o) => this.packQuestions(o.questions, skillId, roundType, "company_pack", entry.pack.id));
    return [
      ...overlayQuestions,
      ...this.packQuestions(entry.pack.questions, skillId, roundType, "company_pack", entry.pack.id),
    ];
  }

  rolePackQuestions(rolePackId: string, skillId: SkillId, roundType: string): QuestionCandidate[] {
    this.ensureLoaded();
    const pack = this.rolePacks.get(rolePackId)?.pack;
    if (!pack) return [];
    return this.packQuestions(pack.questions, skillId, roundType, "role_pack", pack.id);
  }

  /** Role-pack rubric criteria for a skill/mode (interviewer + evaluator guidance). */
  roleRubrics(rolePackId: string | undefined, skillId: SkillId, mode: string): string[] {
    this.ensureLoaded();
    if (!rolePackId) return [];
    const pack = this.rolePacks.get(rolePackId)?.pack;
    if (!pack) return [];
    return pack.rubrics
      .filter(
        (r) =>
          (r.skillId === skillId || r.skillId === undefined) &&
          (r.mode === mode || r.mode === undefined),
      )
      .flatMap((r) => r.criteria);
  }

  rolePackResources(rolePackId: string | undefined, skillId: SkillId): PrepResource[] {
    this.ensureLoaded();
    if (!rolePackId) return [];
    const pack = this.rolePacks.get(rolePackId)?.pack;
    if (!pack) return [];
    return pack.resources
      .filter((r) => matchesSkill(r.skillId, skillId) || r.skillId === skillId)
      .map((r) => ({ ...r, skillId, source: `pack:${pack.id}` }));
  }
}
