import { newId, transition, type AnswerEvaluation } from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { interviewDebrief } from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";

const OVERALL_SKILL_ID = "__overall__";

export class DebriefService {
  constructor(private readonly ctx: WorkflowContext) {}

  async createDebrief(sessionId: string, opts?: ProgressOptions) {
    return this.createDebriefInternal(sessionId, opts);
  }

  async createDebriefInternal(sessionId: string, opts?: ProgressOptions) {
    const session = await this.ctx.store.getSession(sessionId);
    if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const existing = await this.ctx.store.getDebrief(sessionId);
    const status = session.status as import("@interview-os/core").InterviewStatus;
    if (status === "complete") {
      await this.ctx.transitionSession(sessionId, "debrief", "debrief");
    } else if (status !== "debrief") {
      transition(status, "debrief"); // throws
    }

    const { target } = await this.ctx.requireActive();
    const questions = await this.ctx.store.listQuestions(sessionId);
    const evaluations = (await this.ctx.store.listEvaluations(sessionId)).map(
      (r) => r.data as unknown as AnswerEvaluation,
    );
    const latest = await this.ctx.store.latestReadinessBySkill();
    const afterMap: Record<string, number | null> = {};
    const beforeMap: Record<string, number | null> = {};
    for (const [skillId, row] of latest) {
      if (skillId === OVERALL_SKILL_ID) continue;
      afterMap[skillId] = row.score;
    }
    // readiness "before" = latest snapshot at or before session creation
    for (const skillId of Object.keys(afterMap)) {
      const history = await this.ctx.store.readinessHistory(skillId);
      const beforeRow = history.find((r) => r.computedAt <= session.createdAt);
      beforeMap[skillId] = beforeRow ? beforeRow.score : null;
    }

    let output;
    if (existing) {
      output = existing.data;
    } else {
      opts?.onProgress?.({ stage: "writing debrief" });
      output = await this.ctx.host.invoke(
        interviewDebrief,
        {
          role: target.role,
          questions: questions.map((q) => ({
            text: q.text,
            skillId: q.skillId,
            topic: q.topic,
          })),
          evaluations: evaluations as unknown[],
          readinessBefore: beforeMap,
          readinessAfter: afterMap,
          openActions: (await this.ctx.store.listActions("open")).map((a) => ({
            skillId: a.skillId,
            action: a.action,
          })),
        },
        await this.ctx.ctx({ sessionId, onProgress: opts?.onProgress }),
      );
      this.ctx.host.assertCan("interview-debrief", "interview.write");
      await this.ctx.store.insertDebrief({
        id: newId("debrief"),
        sessionId,
        data: output as object,
        createdAt: this.ctx.iso(),
      });
    }
    return output;
  }
}
