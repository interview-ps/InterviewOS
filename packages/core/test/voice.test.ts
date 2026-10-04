import { describe, expect, it } from "vitest";
import {
  countFillers,
  VOICE_DISCLAIMER,
  voiceFeedback,
  VoiceFeedbackSchema,
  VoiceMetricsSchema,
  type VoiceMetrics,
} from "../src/index.js";

const metrics = (over: Partial<VoiceMetrics> = {}): VoiceMetrics => ({
  durationSec: 60,
  longPauseCount: 0,
  longestPauseSec: 0,
  ...over,
});

const status = (fb: ReturnType<typeof voiceFeedback>, id: string) =>
  fb.signals.find((s) => s.id === id)?.status;

const clean =
  "I built the service. First I designed the schema. Then I shipped it. " +
  "Finally it handled load. As a result, latency dropped by 40 percent.";

describe("VoiceMetricsSchema", () => {
  it("rejects out-of-range metrics", () => {
    expect(VoiceMetricsSchema.safeParse(metrics({ durationSec: 3601 })).success).toBe(false);
    expect(VoiceMetricsSchema.safeParse(metrics({ longPauseCount: 1.5 })).success).toBe(false);
    expect(VoiceMetricsSchema.safeParse(metrics({ longestPauseSec: -1 })).success).toBe(false);
    expect(VoiceMetricsSchema.safeParse(metrics()).success).toBe(true);
  });
});

describe("countFillers", () => {
  it("counts documented filler words", () => {
    expect(countFillers("um, so, uh, basically it worked, erm")).toBe(4);
    expect(countFillers("you know, it was fine, you know")).toBe(2);
    expect(countFillers("sort of okay and kind of slow")).toBe(2);
    expect(countFillers("Actually, I led the team.")).toBe(1);
  });

  it("counts 'like' only as filler, not in normal usage", () => {
    expect(countFillers("I like programming and systems like Kafka")).toBe(0);
    expect(countFillers("it was, like, really hard")).toBe(1);
    expect(countFillers("it was like, really hard")).toBe(1);
  });

  it("does not count 'actually' mid-sentence", () => {
    expect(countFillers("the fix actually worked")).toBe(0);
  });
});

describe("voiceFeedback", () => {
  it("validates against VoiceFeedbackSchema and carries the disclaimer", () => {
    const fb = voiceFeedback(metrics(), clean);
    expect(VoiceFeedbackSchema.parse(fb)).toBeTruthy();
    expect(fb.disclaimer).toBe(VOICE_DISCLAIMER);
    expect(fb.disclaimer).toContain("does not assess accent");
  });

  it("computes wordCount/fillerCount server-side", () => {
    const fb = voiceFeedback(metrics(), "um hi there");
    expect(fb.wordCount).toBe(3);
    expect(fb.fillerCount).toBe(1);
  });

  it("computes wordsPerMinute from duration", () => {
    const fb = voiceFeedback(metrics({ durationSec: 30 }), "one two three four five six");
    expect(fb.wordsPerMinute).toBe(12);
    expect(voiceFeedback(metrics({ durationSec: 0 }), "one").wordsPerMinute).toBeNull();
  });

  it("filler: watch when fillers exceed 6 per 100 words", () => {
    const dense = Array.from({ length: 10 }, () => "um").join(" ") +
      " " + Array.from({ length: 90 }, () => "word").join(" ");
    const fb = voiceFeedback(metrics(), dense);
    expect(fb.fillerCount).toBe(10);
    expect(status(fb, "filler")).toBe("watch");
    expect(status(voiceFeedback(metrics(), clean), "filler")).toBe("ok");
  });

  it("pauses: watch on >=3 long pauses or a single >8s pause", () => {
    expect(status(voiceFeedback(metrics({ longPauseCount: 3 }), clean), "pauses")).toBe("watch");
    expect(status(voiceFeedback(metrics({ longestPauseSec: 9 }), clean), "pauses")).toBe("watch");
    expect(status(voiceFeedback(metrics({ longPauseCount: 2, longestPauseSec: 8 }), clean), "pauses")).toBe("ok");
  });

  it("length: watch over 180s or 450 words", () => {
    expect(status(voiceFeedback(metrics({ durationSec: 181 }), clean), "length")).toBe("watch");
    const long = Array.from({ length: 460 }, () => "word").join(" ") + ". So done.";
    expect(status(voiceFeedback(metrics(), long), "length")).toBe("watch");
    expect(status(voiceFeedback(metrics(), clean), "length")).toBe("ok");
  });

  it("conclusion: watch when the last sentences lack result/summary markers", () => {
    const noConclusion =
      "I designed the schema with careful attention to indexes and constraints. " +
      "I built the service layer with retries and timeouts everywhere. " +
      "It was deployed last week behind the new gateway across all three regions. " +
      "The team reviewed the rollout plan the next morning. " +
      "Everyone went home.";
    expect(status(voiceFeedback(metrics(), noConclusion), "conclusion")).toBe("watch");
    expect(status(voiceFeedback(metrics(), clean), "conclusion")).toBe("ok");
    const numberEnding =
      "I designed the schema. I built the service. Latency dropped to 120ms.";
    expect(status(voiceFeedback(metrics(), numberEnding), "conclusion")).toBe("ok");
  });

  it("structure: watch on >120 words with <3 sentences", () => {
    const runOn = Array.from({ length: 130 }, () => "word").join(" ") + ".";
    expect(status(voiceFeedback(metrics(), runOn), "structure")).toBe("watch");
  });

  it("structure: watch on >200 words without sequencing markers", () => {
    const long =
      Array.from({ length: 80 }, () => "plain sentence here.").join(" ") +
      " Overall it worked.";
    expect(long.split(/\s+/).length).toBeGreaterThan(200);
    expect(
      status(voiceFeedback(metrics(), long), "structure"),
    ).toBe("watch");
    expect(status(voiceFeedback(metrics(), clean), "structure")).toBe("ok");
  });

  it("clarity: watch when mean sentence length exceeds 35 words", () => {
    const longSentence = Array.from({ length: 80 }, () => "word").join(" ") +
      ". As a result, done.";
    expect(status(voiceFeedback(metrics(), longSentence), "clarity")).toBe("watch");
    expect(status(voiceFeedback(metrics(), clean), "clarity")).toBe("ok");
  });

  it("ok signals carry a message", () => {
    const fb = voiceFeedback(metrics(), clean);
    for (const s of fb.signals) {
      expect(s.message.length).toBeGreaterThan(0);
      expect(s.status).toBe("ok");
    }
  });
});
