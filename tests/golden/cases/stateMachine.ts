/**
 * Golden cases for packages/core/src/interview/state-machine.ts.
 * The full status × event matrix is enumerated from the module's own
 * exported constants — not a hand-written list — so new states/events are
 * picked up automatically when the schema changes.
 */

import { INTERVIEW_STATES, InterviewEventSchema } from "@interview-os/core";

import type { AreaCases } from "./helpers.js";

const STATUSES: readonly string[] = INTERVIEW_STATES;
const EVENTS: readonly string[] = InterviewEventSchema.options;

export const stateMachineCases: AreaCases = {
  area: "state-machine",
  cases: [
    ...STATUSES.flatMap((status) =>
      EVENTS.map((event) => ({
        fn: "transition",
        name: `transition ${status} + ${event}`,
        input: { status, event },
      })),
    ),
    ...STATUSES.flatMap((status) =>
      EVENTS.map((event) => ({
        fn: "canTransition",
        name: `canTransition ${status} + ${event}`,
        input: { status, event },
      })),
    ),
    ...STATUSES.map((status) => ({
      fn: "nextEvents",
      name: `nextEvents ${status}`,
      input: { status },
    })),
  ],
};
