import type { InterviewSkill } from "../framework/skill.js";
import { resumeAnalyzer } from "../analyze/resume-analyzer/index.js";
import { jdAnalyzer } from "../analyze/jd-analyzer/index.js";
import { gapAnalyzer } from "../analyze/gap-analyzer/index.js";
import { companyProfiler } from "../analyze/company-profiler/index.js";
import { prepPlanner } from "../prepare/prep-planner/index.js";
import { starCoach } from "../prepare/star-coach/index.js";
import { resumeCoach } from "../prepare/resume-coach/index.js";
import { interviewPlanner } from "../interview/interview-planner/index.js";
import { interviewer } from "../interview/interviewer/index.js";
import { answerEvaluator } from "../evaluate/answer-evaluator/index.js";
import { interviewDebrief } from "../evaluate/interview-debrief/index.js";
import { loopDebrief } from "../evaluate/loop-debrief/index.js";
import type { SkillHost } from "./SkillHost.js";

/** Every built-in skill, in pipeline order. */
export const BUILTIN_SKILLS: InterviewSkill<never, unknown>[] = [
  resumeAnalyzer,
  jdAnalyzer,
  gapAnalyzer,
  companyProfiler,
  prepPlanner,
  starCoach,
  resumeCoach,
  interviewPlanner,
  interviewer,
  answerEvaluator,
  interviewDebrief,
  loopDebrief,
] as InterviewSkill<never, unknown>[];

/** §9.6: register all built-ins on a host. */
export function registerBuiltinSkills(host: SkillHost): void {
  for (const skill of BUILTIN_SKILLS) host.register(skill);
}
