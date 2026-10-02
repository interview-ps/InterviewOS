import type { MockRuntime } from "@interview-os/runtime";
import { resumeAnalyzerMock } from "../analyze/resume-analyzer/mock.js";
import { jdAnalyzerMock } from "../analyze/jd-analyzer/mock.js";
import { prepPlannerMock } from "../prepare/prep-planner/mock.js";
import { interviewerMock } from "../interview/interviewer/mock.js";
import { answerEvaluatorMock } from "../evaluate/answer-evaluator/mock.js";
import { interviewDebriefMock } from "../evaluate/interview-debrief/mock.js";

/** Registers every AI skill's deterministic handler on a MockRuntime. */
export function registerMockHandlers(runtime: MockRuntime): void {
  runtime.register("resume-analyzer", resumeAnalyzerMock);
  runtime.register("jd-analyzer", jdAnalyzerMock);
  runtime.register("prep-planner", prepPlannerMock);
  runtime.register("interviewer", interviewerMock);
  runtime.register("answer-evaluator", answerEvaluatorMock);
  runtime.register("interview-debrief", interviewDebriefMock);
}
