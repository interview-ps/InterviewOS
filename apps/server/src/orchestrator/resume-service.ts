import {
  atsCheck,
  guardSuggestion,
  newId,
  ResumeReviewSchema,
  selectWeakestBullets,
  taxonomy,
  type Gap,
  type ResumeReview,
  type ResumeSuggestion,
  type ResumeTailoring,
  type SkillId,
} from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { resumeCoach, type ResumeCoachBulletsOutput } from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";

export interface ResumeServiceDeps {
  ctx: WorkflowContext;
  /** Deterministic gap calculation (§9.5 links prepGaps to real gaps). */
  calculateGaps(): Promise<Gap[]>;
  recordUsageEvent(event: string): Promise<void>;
}

export class ResumeService {
  constructor(private readonly deps: ResumeServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  /**
   * Deterministic ATS check + resume-coach bullets/tailor (run concurrently).
   * Every suggestion passes guardSuggestion before persisting — the coach
   * never creates evidence and never changes readiness.
   */
  async reviewResume(opts?: ProgressOptions): Promise<ResumeReview> {
    const { candidate, target } = await this.ctx.requireActive();
    const candidateRow = (await this.ctx.store.getActiveCandidate())!;
    const resumeText = candidateRow.resumeText;
    if (!resumeText.trim()) {
      throw new AppError(
        "VALIDATION",
        "no resume on file — set up the workspace first",
      );
    }

    opts?.onProgress?.({ stage: "checking ATS" });
    const requirements = this.ctx.allRequirements(target);
    const ats = atsCheck(resumeText, requirements);
    const weakBullets = selectWeakestBullets(resumeText, 8);

    opts?.onProgress?.({ stage: "improving bullets" });
    opts?.onProgress?.({ stage: "tailoring to role" });
    const [bulletsOut, tailorOut] = await Promise.all([
      weakBullets.length > 0
        ? this.ctx.host.invoke(
            resumeCoach,
            { mode: "bullets", resumeText, bullets: weakBullets },
            await this.ctx.ctx({ onProgress: opts?.onProgress }),
          )
        : Promise.resolve({ suggestions: [] }),
      this.ctx.host.invoke(
        resumeCoach,
        {
          mode: "tailor",
          resumeText,
          requirements,
          role: target.role,
          level: target.level,
        },
        await this.ctx.ctx({ onProgress: opts?.onProgress }),
      ),
    ]);
    const bulletSuggestions =
      (bulletsOut as ResumeCoachBulletsOutput).suggestions ?? [];
    const tailoring = (tailorOut as ResumeTailoring) ?? null;

    // §9.5 guard: substitute invented numbers, drop invented entities.
    const substitutions: string[] = [];
    let dropped = 0;
    const suggestions: ResumeSuggestion[] = bulletSuggestions.map((s) => {
      const g = guardSuggestion(s.original, s.improved, resumeText);
      substitutions.push(...g.substitutions);
      if (!g.ok) {
        dropped += 1;
        return { ...s, improved: g.improved, dropped: g.dropped };
      }
      return { ...s, improved: g.improved };
    });
    this.ctx.logger.info("resume.guard", {
      substitutions: substitutions.length,
      dropped,
    });

    // §9.5: link prepGaps to real requirement gaps — no evidence, no
    // readiness change.
    const gaps = await this.deps.calculateGaps();
    const linkedGapSkillIds = [...new Set(
      (tailoring?.prepGaps ?? [])
        .map((pg) => {
          const normalized = taxonomy.normalizeSkillId(pg);
          const hit = gaps.find(
            (g) =>
              g.skillId === normalized ||
              g.label.toLowerCase() === pg.toLowerCase(),
          );
          return hit?.skillId ?? null;
        })
        .filter((id): id is SkillId => id !== null),
    )];

    const review: ResumeReview = {
      id: newId("rev"),
      candidateId: candidate.id,
      targetId: target.id,
      ats,
      suggestions,
      tailoring,
      linkedGapSkillIds,
      guard: { substitutions: substitutions.length, dropped },
      createdAt: this.ctx.iso(),
    };
    this.ctx.host.assertCan("resume-coach", "resume.write");
    await this.ctx.store.insertResumeReview(ResumeReviewSchema.parse(review));
    await this.deps.recordUsageEvent("resume.coach.used");
    this.ctx.logger.info("state.mutated", { entity: "resume_review", id: review.id });
    return review;
  }

  /** Most recent persisted resume review, or null. */
  async latestResumeReview(): Promise<ResumeReview | null> {
    const row = await this.ctx.store.latestResumeReview();
    if (!row) return null;
    const parsed = ResumeReviewSchema.safeParse({
      id: row.id,
      candidateId: row.candidateId,
      targetId: row.targetId,
      ats: row.ats,
      suggestions: row.suggestions,
      tailoring: row.tailoring,
      linkedGapSkillIds: row.linkedGapSkillIds,
      guard: row.guard,
      createdAt: row.createdAt,
    });
    return parsed.success ? parsed.data : null;
  }
}
