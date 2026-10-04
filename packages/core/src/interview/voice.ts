import { z } from "zod";

/**
 * v0.4 voice mode — delivery hints only. All metrics are client-measured and
 * all counts are recomputed server-side from the transcript; nothing here
 * feeds evaluation or evidence.
 */
export const VoiceMetricsSchema = z.object({
  durationSec: z.number().min(0).max(3600),
  longPauseCount: z.number().int().min(0),
  longestPauseSec: z.number().min(0).max(3600),
});
export type VoiceMetrics = z.infer<typeof VoiceMetricsSchema>;

export const VoiceSignalSchema = z.object({
  id: z.enum(["structure", "filler", "pauses", "length", "conclusion", "clarity"]),
  status: z.enum(["ok", "watch"]),
  message: z.string().min(1).max(300),
});
export type VoiceSignal = z.infer<typeof VoiceSignalSchema>;

export const VoiceFeedbackSchema = z.object({
  signals: z.array(VoiceSignalSchema).length(6),
  wordCount: z.number().int().min(0),
  fillerCount: z.number().int().min(0),
  /** null when duration is too short to be meaningful (< 10 s). */
  wordsPerMinute: z.number().nullable(),
  disclaimer: z.string(),
});
export type VoiceFeedback = z.infer<typeof VoiceFeedbackSchema>;

export const VOICE_DISCLAIMER =
  "Delivery hints only. Interview OS does not assess accent, pronunciation or voice characteristics, and these signals do not predict job performance.";

const FILLER_PATTERNS: [RegExp, string][] = [
  [/\b(um+|uh+|erm+|er+)\b/gi, "hesitation"],
  [/\b(you know|i mean)\b/gi, "verbal crutch"],
  [/\b(sort of|kind of)\b/gi, "hedge"],
  // "like" is a real word — only count it as a filler when it clearly isn't a
  // verb/preposition: pausal ("… like, …"), comma-delimited, or clause-initial.
  [/\blike,|(?:^|[,.;]\s*)like[,.]/gim, "discourse like"],
  [/(?:^|[,.;]\s*)(basically|actually|literally)\b/gim, "intensifier crutch"],
];

/**
 * Rough spoken-filler count. Heuristic only — "like" is counted only in
 * pausal/clause-initial positions ("…, like, …", "Like, …") to avoid counting
 * the verb/preposition.
 */
export function countFillers(text: string): number {
  let count = 0;
  for (const [pattern] of FILLER_PATTERNS) {
    pattern.lastIndex = 0;
    count += (text.match(pattern) ?? []).length;
  }
  return count;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sentences(text: string): string[] {
  return text
    .split(/[.!?]+\s+|[.!?]+$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SEQUENCING =
  /\b(first|firstly|then|next|after that|finally|situation|task|action|result|in the end)\b/i;
const CONCLUSION =
  /\b(so,|so |in summary|to summarize|as a result|overall|ultimately|which led to|that's why|in the end|\d+(\.\d+)?%)/i;

/** Deterministic delivery-hint signals from metrics + transcript. */
export function voiceFeedback(
  metrics: VoiceMetrics,
  transcript: string,
): VoiceFeedback {
  const parsed = VoiceMetricsSchema.parse(metrics);
  const wordCount = words(transcript).length;
  const fillerCount = countFillers(transcript);
  const sents = sentences(transcript);
  const wpm =
    parsed.durationSec >= 10
      ? Math.round((wordCount / parsed.durationSec) * 60)
      : null;

  const signals: VoiceSignal[] = [];

  const structureWatch =
    (wordCount > 120 && sents.length < 3) ||
    (wordCount > 200 && !SEQUENCING.test(transcript));
  signals.push({
    id: "structure",
    status: structureWatch ? "watch" : "ok",
    message: structureWatch
      ? "Hard to follow — break the answer into more sentences or use sequencing markers (first / then / finally)."
      : "Answer reads as structured.",
  });

  const fillerWatch = wordCount > 0 && (fillerCount / wordCount) * 100 > 6;
  signals.push({
    id: "filler",
    status: fillerWatch ? "watch" : "ok",
    message: fillerWatch
      ? `${fillerCount} filler words in ${wordCount} words — pause silently instead of filling.`
      : "Filler usage is within a normal range.",
  });

  const pauseWatch = parsed.longPauseCount >= 3 || parsed.longestPauseSec > 8;
  signals.push({
    id: "pauses",
    status: pauseWatch ? "watch" : "ok",
    message: pauseWatch
      ? `${parsed.longPauseCount} long pause(s), longest ${parsed.longestPauseSec}s — practice a bridging phrase.`
      : "Pacing looks comfortable.",
  });

  const lengthWatch = parsed.durationSec > 180 || wordCount > 450;
  signals.push({
    id: "length",
    status: lengthWatch ? "watch" : "ok",
    message: lengthWatch
      ? "Long answer — aim for ~2 minutes; lead with the headline, then detail."
      : "Length is within a good range.",
  });

  const tail = sents.slice(-2).join(" ");
  const conclusionWatch = wordCount >= 40 && !CONCLUSION.test(tail);
  signals.push({
    id: "conclusion",
    status: conclusionWatch ? "watch" : "ok",
    message: conclusionWatch
      ? "No clear wrap-up — end on the result or a one-line takeaway."
      : "Answer lands on a conclusion.",
  });

  const meanSentence = sents.length > 0 ? wordCount / sents.length : 0;
  const clarityWatch = meanSentence > 35;
  signals.push({
    id: "clarity",
    status: clarityWatch ? "watch" : "ok",
    message: clarityWatch
      ? `Average sentence is ${Math.round(meanSentence)} words — shorter sentences sound clearer.`
      : "Sentences are easy to parse.",
  });

  return {
    signals,
    wordCount,
    fillerCount,
    wordsPerMinute: wpm,
    disclaimer: VOICE_DISCLAIMER,
  };
}
