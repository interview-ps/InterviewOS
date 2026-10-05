/**
 * Golden cases for packages/core/src/interview/voice.ts:
 * countFillers and voiceFeedback.
 */

import type { AreaCases } from "./helpers.js";

const OK_METRICS = { durationSec: 90, longPauseCount: 0, longestPauseSec: 1 };

/** ~90 words with sequencing markers and a measurable conclusion. */
const STRUCTURED =
  "First, I clarified the requirements with the interviewer. " +
  "Then I sketched the data model and named the consistency trade-offs. " +
  "Next I described the caching layer and its invalidation strategy. " +
  "After that I walked through failure handling and retries. " +
  "Finally I reviewed the monitoring plan. " +
  "So, in summary, the design reduced p99 latency by 40% overall.";

/** >120 words in one sentence → structure watch. */
const RUN_ON =
  "well " +
  Array.from({ length: 130 }, (_, i) => `word${i}`).join(" ") +
  " and that covers everything";

const FILLER_HEAVY =
  "Um, so, like, I think, uh, the cache, you know, basically, um, " +
  "it sort of works, er, because, I mean, it does.";

export const voiceCases: AreaCases = {
  area: "voice",
  cases: [
    // --- countFillers ---------------------------------------------------------
    { fn: "countFillers", name: "empty text", input: { text: "" } },
    {
      fn: "countFillers",
      name: "clean text",
      input: { text: "I designed the caching layer for our API." },
    },
    {
      fn: "countFillers",
      name: "hesitation family",
      input: { text: "um uh er erm" },
    },
    {
      fn: "countFillers",
      name: "verbal crutches",
      input: { text: "you know, I mean, it was fine" },
    },
    {
      fn: "countFillers",
      name: "hedges",
      input: { text: "sort of a kind of problem" },
    },
    {
      fn: "countFillers",
      name: "like as verb is not a filler, pausal like is",
      input: { text: "I like turtles. Like, really." },
    },
    {
      fn: "countFillers",
      name: "intensifier crutches",
      input: { text: "Basically, it worked. Actually, it did, literally." },
    },
    {
      fn: "countFillers",
      name: "case insensitive",
      input: { text: "UM Uh you KNOW" },
    },
    {
      fn: "countFillers",
      name: "punctuation and clause-initial positions",
      input: { text: "First. Actually, second. Basically, third." },
    },
    {
      fn: "countFillers",
      name: "embedded like within clause stays clean",
      input: { text: "tools like Redis or systems like Kafka" },
    },

    // --- voiceFeedback ----------------------------------------------------------
    {
      fn: "voiceFeedback",
      name: "structured answer all clear",
      input: { metrics: OK_METRICS, transcript: STRUCTURED },
    },
    {
      fn: "voiceFeedback",
      name: "short clip has null wordsPerMinute",
      input: {
        metrics: { durationSec: 5, longPauseCount: 0, longestPauseSec: 0 },
        transcript: "A very brief answer.",
      },
    },
    {
      fn: "voiceFeedback",
      name: "filler heavy transcript",
      input: { metrics: OK_METRICS, transcript: FILLER_HEAVY },
    },
    {
      fn: "voiceFeedback",
      name: "many long pauses",
      input: {
        metrics: { durationSec: 120, longPauseCount: 4, longestPauseSec: 3 },
        transcript: STRUCTURED,
      },
    },
    {
      fn: "voiceFeedback",
      name: "single very long pause",
      input: {
        metrics: { durationSec: 90, longPauseCount: 1, longestPauseSec: 9 },
        transcript: STRUCTURED,
      },
    },
    {
      fn: "voiceFeedback",
      name: "overlong duration",
      input: {
        metrics: { durationSec: 200, longPauseCount: 0, longestPauseSec: 1 },
        transcript: STRUCTURED,
      },
    },
    {
      fn: "voiceFeedback",
      name: "run-on answer trips structure and clarity",
      input: { metrics: OK_METRICS, transcript: RUN_ON },
    },
    {
      fn: "voiceFeedback",
      name: "long answer without a wrap-up trips conclusion",
      input: {
        metrics: OK_METRICS,
        transcript:
          "I set up the service with a postgres primary and two replicas. " +
          "Writes go to the primary while reads fan out across the replicas. " +
          "The schema is normalized up to the order_items table. " +
          "Background jobs handle cleanup through a scheduled worker.",
      },
    },
    {
      fn: "voiceFeedback",
      name: "empty transcript",
      input: { metrics: OK_METRICS, transcript: "" },
    },
    {
      fn: "voiceFeedback",
      name: "invalid metrics throw a ZodError",
      input: {
        metrics: { durationSec: -5, longPauseCount: 0, longestPauseSec: 0 },
        transcript: "hi",
      },
    },
  ],
};
