import type { MockRuntime } from "@interview-os/runtime";
import { resumeAnalyzerMock } from "../analyze/resume-analyzer/mock.js";
import { jdAnalyzerMock } from "../analyze/jd-analyzer/mock.js";
import { prepPlannerMock } from "../prepare/prep-planner/mock.js";
import { interviewerMock } from "../interview/interviewer/mock.js";
import { answerEvaluatorMock } from "../evaluate/answer-evaluator/mock.js";
import { interviewDebriefMock } from "../evaluate/interview-debrief/mock.js";
import { loopDebriefMock } from "../evaluate/loop-debrief/mock.js";
import { companyProfilerMock } from "../analyze/company-profiler/mock.js";
import {
  starCoachGenerateMock,
  starCoachReviewMock,
} from "../prepare/star-coach/mock.js";
import {
  resumeCoachBulletsMock,
  resumeCoachTailorMock,
} from "../prepare/resume-coach/mock.js";
import { codingEvaluatorMock, codingInterviewerMock } from "../interview/modes/coding/mock.js";
import {
  systemDesignEvaluatorMock,
  systemDesignInterviewerMock,
} from "../interview/modes/system-design/mock.js";
import {
  technicalEvaluatorMock,
  technicalInterviewerMock,
} from "../interview/modes/technical/mock.js";
import {
  behavioralEvaluatorMock,
  behavioralInterviewerMock,
} from "../interview/modes/behavioral/mock.js";
import {
  hiringManagerEvaluatorMock,
  hiringManagerInterviewerMock,
} from "../interview/modes/hiring-manager/mock.js";
import { hrEvaluatorMock, hrInterviewerMock } from "../interview/modes/hr/mock.js";

/** Registers every AI skill's deterministic handler on a MockRuntime. */
export function registerMockHandlers(runtime: MockRuntime): void {
  runtime.register("resume-analyzer", resumeAnalyzerMock);
  runtime.register("jd-analyzer", jdAnalyzerMock);
  runtime.register("prep-planner", prepPlannerMock);
  runtime.register("interviewer", interviewerMock);
  runtime.register("answer-evaluator", answerEvaluatorMock);
  runtime.register("interview-debrief", interviewDebriefMock);
  runtime.register("loop-debrief", loopDebriefMock);
  runtime.register("company-profiler", companyProfilerMock);
  runtime.register("star-coach.generate", starCoachGenerateMock);
  runtime.register("star-coach.review", starCoachReviewMock);
  runtime.register("resume-coach.bullets", resumeCoachBulletsMock);
  runtime.register("resume-coach.tailor", resumeCoachTailorMock);

  // §9.1 per-mode handlers; `mixed` keeps the legacy task ids above.
  runtime.register("interviewer.technical", technicalInterviewerMock);
  runtime.register("answer-evaluator.technical", technicalEvaluatorMock);
  runtime.register("interviewer.coding", codingInterviewerMock);
  runtime.register("answer-evaluator.coding", codingEvaluatorMock);
  runtime.register("interviewer.system_design", systemDesignInterviewerMock);
  runtime.register("answer-evaluator.system_design", systemDesignEvaluatorMock);
  runtime.register("interviewer.behavioral", behavioralInterviewerMock);
  runtime.register("answer-evaluator.behavioral", behavioralEvaluatorMock);
  runtime.register("interviewer.hiring_manager", hiringManagerInterviewerMock);
  runtime.register("answer-evaluator.hiring_manager", hiringManagerEvaluatorMock);
  runtime.register("interviewer.hr", hrInterviewerMock);
  runtime.register("answer-evaluator.hr", hrEvaluatorMock);
}
