import { AppError } from "../shared/index.js";
import { z } from "zod";
import type { InterviewStatus } from "./index.js";

export const INTERVIEW_STATES = [
  "created",
  "analyzing",
  "ready",
  "question",
  "answer",
  "evaluating",
  "follow_up",
  "complete",
  "debrief",
] as const;

export const InterviewEventSchema = z.enum([
  "analyze",
  "analysis_complete",
  "ask",
  "answer",
  "evaluate",
  "evaluation_failed",
  "follow_up",
  "next",
  "complete",
  "debrief",
]);
export type InterviewEvent = z.infer<typeof InterviewEventSchema>;

const TRANSITIONS: Record<InterviewStatus, Partial<Record<InterviewEvent, InterviewStatus>>> = {
  created: { analyze: "analyzing" },
  analyzing: { analysis_complete: "ready" },
  ready: { ask: "question" },
  question: { answer: "answer", complete: "complete" },
  answer: { evaluate: "evaluating" },
  evaluating: { follow_up: "follow_up", evaluation_failed: "question" },
  follow_up: { next: "question", complete: "complete" },
  complete: { debrief: "debrief" },
  debrief: {},
};

export class InvalidTransitionError extends AppError {
  constructor(from: InterviewStatus, event: string) {
    super(
      "INVALID_TRANSITION",
      `invalid interview transition: state "${from}" has no event "${event}"`,
    );
    this.name = "InvalidTransitionError";
  }
}

export function transition(status: InterviewStatus, event: InterviewEvent): InterviewStatus {
  const next = TRANSITIONS[status][event];
  if (next === undefined) {
    throw new InvalidTransitionError(status, event);
  }
  return next;
}

export function canTransition(status: InterviewStatus, event: InterviewEvent): boolean {
  return TRANSITIONS[status][event] !== undefined;
}

export function nextEvents(status: InterviewStatus): InterviewEvent[] {
  return Object.keys(TRANSITIONS[status]) as InterviewEvent[];
}
