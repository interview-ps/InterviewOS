import { describe, expect, it } from "vitest";
import {
  canTransition,
  InterviewSessionSchema,
  InvalidTransitionError,
  nextEvents,
  transition,
} from "../src/index.js";

describe("interview state machine", () => {
  it("walks the happy path", () => {
    let s = transition("created", "analyze");
    expect(s).toBe("analyzing");
    s = transition(s, "analysis_complete");
    expect(s).toBe("ready");
    s = transition(s, "ask");
    expect(s).toBe("question");
    s = transition(s, "answer");
    expect(s).toBe("answer");
    s = transition(s, "evaluate");
    expect(s).toBe("evaluating");
    s = transition(s, "follow_up");
    expect(s).toBe("follow_up");
    s = transition(s, "next");
    expect(s).toBe("question");
    s = transition(s, "complete");
    expect(s).toBe("complete");
    s = transition(s, "debrief");
    expect(s).toBe("debrief");
  });

  it("allows follow_up → complete", () => {
    expect(transition("follow_up", "complete")).toBe("complete");
  });

  it("returns to question when evaluation fails", () => {
    expect(transition("evaluating", "evaluation_failed")).toBe("question");
    expect(canTransition("evaluating", "evaluation_failed")).toBe(true);
    expect(nextEvents("evaluating").sort()).toEqual(["evaluation_failed", "follow_up"]);
  });

  it("throws InvalidTransitionError for invalid events", () => {
    expect(() => transition("created", "answer")).toThrow(InvalidTransitionError);
    expect(() => transition("analyzing", "complete")).toThrow(InvalidTransitionError);
    expect(() => transition("debrief", "analyze")).toThrow(InvalidTransitionError);
    expect(() => transition("question", "evaluate")).toThrow(InvalidTransitionError);
    try {
      transition("ready", "answer");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).code).toBe("INVALID_TRANSITION");
    }
  });

  it("reports canTransition / nextEvents", () => {
    expect(canTransition("question", "answer")).toBe(true);
    expect(canTransition("question", "debrief")).toBe(false);
    expect(nextEvents("follow_up").sort()).toEqual(["complete", "next"]);
    expect(nextEvents("debrief")).toEqual([]);
  });
});

describe("InterviewSessionSchema", () => {
  it("defaults status/round/plannedQuestions", () => {
    const s = InterviewSessionSchema.parse({ id: "s1" });
    expect(s.status).toBe("created");
    expect(s.currentRound).toBe(0);
    expect(s.plannedQuestions).toBe(4);
  });
});
