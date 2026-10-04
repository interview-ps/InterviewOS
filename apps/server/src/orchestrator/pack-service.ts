import YAML from "yaml";
import { z } from "zod";
import {
  AppError,
  InterviewPackSchema,
  ModeIdSchema,
  newId,
  QuestionDifficultySchema,
  SkillIdSchema,
  type InterviewPack,
  type ModeId,
  type QuestionCandidate,
  type SkillId,
} from "@interview-os/core";
import type { WorkflowContext, ProgressOptions } from "./context.js";
import type { InstallablePackKind, PackLoadError } from "../packs/registry.js";
import type { LoopRoundInput } from "./loop-service.js";

export interface InterviewPackView {
  pack: InterviewPack;
  source: "bundled" | "user" | "imported";
  createdAt?: string;
  updatedAt?: string;
}

/** v0.4: everything the /packs UI needs — detail included, text-only. */
export interface PackItemView {
  text: string;
  provenance: "sourced" | "community";
  source?: string;
}
export interface CompanyPackView {
  id: string;
  name: string;
  version: string;
  source: string;
  description: string;
  aliases: string[];
  stages: { mode: string; label: string; plannedQuestions: number; provenance: string; source?: string }[];
  sources: { id: string; title: string; url?: string }[];
  items: { group: string; text: string; provenance: "sourced" | "community"; source?: string }[];
  sourcedCount: number;
  communityCount: number;
}
export interface RolePackView {
  id: string;
  name: string;
  version: string;
  source: string;
  description: string;
  dimensions: { skillId: string; weight: number }[];
  defaultQuestionCategories: string[];
  resources: unknown[];
}
export interface PackListView {
  companies: CompanyPackView[];
  roles: RolePackView[];
  loadErrors: PackLoadError[];
}

const QuestionBankItemSchema = z.object({
  skillId: SkillIdSchema,
  text: z.string().min(10).max(1200),
  difficulty: QuestionDifficultySchema.optional(),
  mode: ModeIdSchema.optional(),
});
export type QuestionBankItem = z.infer<typeof QuestionBankItemSchema>;

const QUESTION_BANK_IMPORT_MAX = 500;

const CreateInterviewPackInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  author: z.string().max(120).default(""),
  version: z.string().min(1).max(32).optional(),
  skills: z.array(SkillIdSchema).min(1).max(12),
  rounds: z
    .array(
      z.object({
        mode: ModeIdSchema,
        label: z.string().min(1).max(80),
        plannedQuestions: z.number().int().min(1).max(6),
      }),
    )
    .min(2)
    .max(7),
  durationMinutes: z.number().int().min(15).max(600),
});

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "pack";
}

export interface PackServiceDeps {
  ctx: WorkflowContext;
  startLoop(
    input: { rounds?: LoopRoundInput[]; packId?: string; focusSkills?: SkillId[] },
    opts?: ProgressOptions,
  ): Promise<unknown>;
}

export class PackService {
  constructor(private readonly deps: PackServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  // ------------------------------------------------------------------- packs

  async listPacks(): Promise<PackListView> {
    await this.ctx.packs.ready();
    return {
      companies: this.ctx.packs.listCompanyPacks().map((e) => {
        const p = e.pack;
        const items = [
          ...p.competencies.map((i) => ({ group: "competencies", ...i })),
          ...p.questionStyle.map((i) => ({ group: "question style", ...i })),
          ...p.evaluationGuidance.map((i) => ({ group: "evaluation guidance", ...i })),
        ];
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          source: e.source,
          description: p.description,
          aliases: p.aliases,
          stages: p.stages,
          sources: p.sources,
          items,
          sourcedCount: items.filter((i) => i.provenance === "sourced").length,
          communityCount: items.filter((i) => i.provenance === "community").length,
        };
      }),
      roles: this.ctx.packs.listRolePacks().map((e) => ({
        id: e.pack.id,
        name: e.pack.name,
        version: e.pack.version,
        source: e.source,
        description: e.pack.description,
        dimensions: e.pack.dimensions,
        defaultQuestionCategories: e.pack.defaultQuestionCategories,
        resources: e.pack.resources,
      })),
      loadErrors: [...this.ctx.packs.loadErrors],
    };
  }

  async installPackFromGit(kind: InstallablePackKind, url: string) {
    await this.ctx.packs.ready();
    return this.ctx.packs.installPackFromGit(kind, url);
  }

  async uninstallPack(kind: InstallablePackKind, id: string): Promise<void> {
    await this.ctx.packs.ready();
    await this.ctx.packs.uninstallPack(kind, id);
  }

  // ------------------------------------------------------------ interview packs

  async listInterviewPacks(): Promise<InterviewPackView[]> {
    await this.ctx.packs.ready();
    const views: InterviewPackView[] = this.ctx.packs
      .listInterviewPacks()
      .map((pack) => ({ pack, source: "bundled" as const }));
    for (const row of await this.store.listInterviewPacks()) {
      const parsed = InterviewPackSchema.safeParse(row.data);
      if (!parsed.success) continue;
      views.push({
        pack: parsed.data,
        source: row.source as "user" | "imported",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return views;
  }

  /** All known packs: DB rows first, bundled fallback. */
  private async findPack(id: string): Promise<{ pack: InterviewPack; source: string } | null> {
    const row = await this.store.getInterviewPack(id);
    if (row) {
      const parsed = InterviewPackSchema.safeParse(row.data);
      if (parsed.success) return { pack: parsed.data, source: row.source };
    }
    await this.ctx.packs.ready();
    const bundled = this.ctx.packs.bundledInterviewPack(id);
    return bundled ? { pack: bundled, source: "bundled" } : null;
  }

  async createInterviewPack(input: z.input<typeof CreateInterviewPackInputSchema>) {
    const parsed = CreateInterviewPackInputSchema.parse(input);
    let id = slugify(parsed.name);
    const taken = new Set((await this.listInterviewPacks()).map((v) => v.pack.id));
    let n = 2;
    while (taken.has(id)) id = `${slugify(parsed.name)}-${n++}`;
    const pack = InterviewPackSchema.parse({
      ...parsed,
      id,
      version: parsed.version ?? "1.0.0",
    });
    const now = this.ctx.iso();
    await this.store.insertInterviewPack({
      id: pack.id,
      data: pack as unknown as object,
      source: "user",
      createdAt: now,
      updatedAt: now,
    });
    this.ctx.logger.info("state.mutated", { entity: "interview_pack", id: pack.id });
    return { pack, source: "user" as const };
  }

  async getInterviewPack(id: string): Promise<InterviewPackView> {
    const found = await this.findPack(id);
    if (!found) throw new AppError("NOT_FOUND", `no interview pack "${id}"`);
    const row = await this.store.getInterviewPack(id);
    return {
      pack: found.pack,
      source: found.source as InterviewPackView["source"],
      createdAt: row?.createdAt,
      updatedAt: row?.updatedAt,
    };
  }

  async deleteInterviewPack(id: string): Promise<void> {
    const row = await this.store.getInterviewPack(id);
    if (!row) {
      const bundled = await this.findPack(id);
      if (bundled) {
        throw new AppError("VALIDATION", `interview pack "${id}" is bundled and read-only`);
      }
      throw new AppError("NOT_FOUND", `no interview pack "${id}"`);
    }
    await this.store.deleteInterviewPack(id);
    this.ctx.logger.info("state.mutated", { entity: "interview_pack", id, deleted: true });
  }

  async exportInterviewPack(id: string): Promise<{ filename: string; content: string }> {
    const found = await this.findPack(id);
    if (!found) throw new AppError("NOT_FOUND", `no interview pack "${id}"`);
    return {
      filename: `${found.pack.id}-${found.pack.version}.interview-pack.yaml`,
      content: YAML.stringify(found.pack),
    };
  }

  /**
   * Import YAML (or JSON) interview-pack content. Same id+version → conflict;
   * bundled ids are read-only; a higher version replaces a user/imported pack.
   */
  async importInterviewPack(content: string): Promise<InterviewPackView> {
    let raw: unknown;
    try {
      raw = YAML.parse(content);
    } catch {
      throw new AppError("VALIDATION", "interview pack content is not valid YAML/JSON");
    }
    let pack: InterviewPack;
    try {
      pack = InterviewPackSchema.parse(raw);
    } catch (err) {
      throw new AppError(
        "VALIDATION",
        `invalid interview pack: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      );
    }
    await this.ctx.packs.ready();
    if (this.ctx.packs.bundledInterviewPack(pack.id)) {
      throw new AppError("CONFLICT", `interview pack id "${pack.id}" is bundled`);
    }
    const existing = await this.store.getInterviewPack(pack.id);
    if (existing) {
      const current = InterviewPackSchema.safeParse(existing.data);
      if (current.success) {
        const cmp = compareVersions(current.data.version, pack.version);
        if (cmp >= 0) {
          throw new AppError(
            "CONFLICT",
            `interview pack "${pack.id}" v${current.data.version} already exists`,
          );
        }
      }
    }
    const now = this.ctx.iso();
    await this.store.upsertInterviewPack({
      id: pack.id,
      data: pack as unknown as object,
      source: "imported",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.ctx.logger.info("state.mutated", { entity: "interview_pack", id: pack.id });
    return { pack, source: "imported" };
  }

  /** Start a loop from an interview pack: rounds + focus skills come from the pack. */
  async startLoopFromPack(id: string, opts?: ProgressOptions) {
    const found = await this.findPack(id);
    if (!found) throw new AppError("NOT_FOUND", `no interview pack "${id}"`);
    return this.deps.startLoop(
      {
        rounds: found.pack.rounds.map((r) => ({
          mode: r.mode,
          label: r.label,
          plannedQuestions: r.plannedQuestions,
        })),
        packId: found.pack.id,
        focusSkills: found.pack.skills,
      },
      opts,
    );
  }

  // ------------------------------------------------------------ question bank

  async listQuestionBank(): Promise<QuestionCandidate[]> {
    const rows = await this.store.listUserQuestions();
    return rows.map((r) => ({
      skillId: r.skillId as SkillId,
      text: r.text,
      difficulty: (r.difficulty ?? undefined) as QuestionCandidate["difficulty"],
      mode: (r.mode ?? undefined) as ModeId | undefined,
      source: { kind: "user_bank", id: r.id },
    }));
  }

  async addUserQuestion(item: QuestionBankItem) {
    const parsed = QuestionBankItemSchema.parse(item);
    const row = {
      id: newId("uq"),
      skillId: parsed.skillId,
      text: parsed.text,
      difficulty: parsed.difficulty ?? null,
      mode: parsed.mode ?? null,
      createdAt: this.ctx.iso(),
    };
    await this.store.insertUserQuestion(row);
    this.ctx.logger.info("state.mutated", { entity: "user_question", id: row.id });
    return {
      id: row.id,
      skillId: parsed.skillId,
      text: parsed.text,
      difficulty: parsed.difficulty ?? null,
      mode: parsed.mode ?? null,
      createdAt: row.createdAt,
    };
  }

  async deleteUserQuestion(id: string): Promise<void> {
    const row = await this.store.getUserQuestion(id);
    if (!row) throw new AppError("NOT_FOUND", `no question "${id}"`);
    await this.store.deleteUserQuestion(id);
  }

  /** All-or-nothing import of a YAML/JSON question-bank array (max 500). */
  async importQuestionBank(content: string): Promise<{ imported: number }> {
    let raw: unknown;
    try {
      raw = YAML.parse(content);
    } catch {
      throw new AppError("VALIDATION", "question bank content is not valid YAML/JSON");
    }
    let items: QuestionBankItem[];
    try {
      items = z.array(QuestionBankItemSchema).max(QUESTION_BANK_IMPORT_MAX).parse(raw);
    } catch (err) {
      throw new AppError(
        "VALIDATION",
        `invalid question bank: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      );
    }
    const createdAt = this.ctx.iso();
    await this.store.transaction(async (tx) => {
      for (const item of items) {
        await tx.insertUserQuestion({
          id: newId("uq"),
          skillId: item.skillId,
          text: item.text,
          difficulty: item.difficulty ?? null,
          mode: item.mode ?? null,
          createdAt,
        });
      }
    });
    this.ctx.logger.info("state.mutated", { entity: "user_question", imported: items.length });
    return { imported: items.length };
  }
}

/** Loose semver compare: numeric x.y.z; returns <0 / 0 / >0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
