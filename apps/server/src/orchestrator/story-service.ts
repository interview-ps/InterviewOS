import { inRound, newId, type SkillId } from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { starCoach, type StarCoachReviewOutput } from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";

export class StoryService {
  constructor(private readonly ctx: WorkflowContext) {}

  listStories() {
    const { candidate } = this.ctx.requireActive();
    return this.ctx.store.listStories(candidate.id);
  }

  /** Generate resume-grounded STAR stories via star-coach; dedupe by title. */
  async generateStories(opts?: ProgressOptions) {
    const { candidate, target } = this.ctx.requireActive();
    opts?.onProgress?.({ stage: "drafting stories" });
    const behavioralSkillIds = [...target.requirements, ...target.preferredSkills]
      .map((r) => r.skillId)
      .filter((id) => inRound(id, "behavioral") || inRound(id, "hr"));
    const existing = this.ctx.store.listStories(candidate.id);
    const out = (await this.ctx.host.invoke(
      starCoach,
      {
        mode: "generate" as const,
        experience: candidate.experience,
        achievements: candidate.achievements,
        projects: candidate.projects,
        behavioralSkillIds,
        existingTitles: existing.map((s) => s.title),
      },
      this.ctx.ctx({ onProgress: opts?.onProgress }),
    )) as { stories: Array<{ title: string; situation: string; task: string; action: string; result: string; skillIds: SkillId[] }> };
    // §9.6: star-coach output persists generated stories.
    this.ctx.host.assertCan("star-coach", "stories.write");
    const taken = new Set(existing.map((s) => s.title.toLowerCase()));
    const created = [];
    for (const s of out.stories) {
      if (taken.has(s.title.toLowerCase())) continue;
      taken.add(s.title.toLowerCase());
      const id = newId("story");
      this.ctx.store.insertStory({
        id,
        candidateId: candidate.id,
        title: s.title,
        situation: s.situation,
        task: s.task,
        action: s.action,
        result: s.result,
        skillIds: s.skillIds,
        source: "generated",
        updatedAt: this.ctx.iso(),
      });
      created.push(this.ctx.store.getStory(id)!);
    }
    this.ctx.logger.info("state.mutated", {
      entity: "star_story",
      id: `${created.length} generated`,
    });
    return { stories: this.ctx.store.listStories(candidate.id), created: created.length };
  }

  /** User edits mark the story as theirs (source 'user'). */
  async updateStory(
    id: string,
    patch: {
      title?: string;
      situation?: string;
      task?: string;
      action?: string;
      result?: string;
      skillIds?: SkillId[];
    },
  ) {
    const row = this.ctx.store.getStory(id);
    if (!row) throw new AppError("NOT_FOUND", `no story ${id}`);
    this.ctx.store.updateStory(id, {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.situation !== undefined && { situation: patch.situation }),
      ...(patch.task !== undefined && { task: patch.task }),
      ...(patch.action !== undefined && { action: patch.action }),
      ...(patch.result !== undefined && { result: patch.result }),
      ...(patch.skillIds !== undefined && { skillIds: patch.skillIds }),
      source: "user",
      updatedAt: this.ctx.iso(),
    });
    this.ctx.logger.info("state.mutated", { entity: "star_story", id });
    return this.ctx.store.getStory(id);
  }

  /** Coach review of one story (star-coach.review); streams `feedback`. */
  async coachStory(id: string, opts?: ProgressOptions): Promise<StarCoachReviewOutput> {
    const { target } = this.ctx.requireActive();
    const row = this.ctx.store.getStory(id);
    if (!row) throw new AppError("NOT_FOUND", `no story ${id}`);
    opts?.onProgress?.({ stage: "coaching story" });
    return (await this.ctx.host.invoke(
      starCoach,
      {
        mode: "review" as const,
        story: {
          title: row.title,
          situation: row.situation,
          task: row.task,
          action: row.action,
          result: row.result,
          skillIds: (row.skillIds as string[]) ?? [],
        },
        role: target.role,
        level: target.level,
      },
      this.ctx.ctx({ onProgress: opts?.onProgress }),
    )) as StarCoachReviewOutput;
  }
}
