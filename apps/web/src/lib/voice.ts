import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceMetrics } from "./api";

interface SpeechAlternative {
  transcript: string;
  isFinal?: boolean;
}
interface SpeechResultItem {
  isFinal: boolean;
  0: SpeechAlternative;
  length: number;
}
interface SpeechResultList {
  length: number;
  [index: number]: SpeechResultItem;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

const LONG_PAUSE_SEC = 3;

function ctor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as SpeechRecognitionCtor | undefined) ??
    (w.webkitSpeechRecognition as SpeechRecognitionCtor | undefined) ??
    null
  );
}

export const speechSupported = (): boolean => ctor() !== null;

interface Capture {
  startedAt: number;
  lastEventAt: number;
  longPauseCount: number;
  longestPauseSec: number;
}

/**
 * Mic capture for session answers: continuous recognition with interim
 * results; final transcripts are appended via `onFinal`. Metrics (duration,
 * long pauses between result events) are accumulated and returned by
 * `takeMetrics` at submit time.
 */
export function useVoiceCapture(onFinal: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const capRef = useRef<Capture | null>(null);
  const doneRef = useRef<VoiceMetrics | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    const cap = capRef.current;
    if (cap) {
      const now = Date.now();
      doneRef.current = {
        durationSec: Math.max(0, Math.min(3600, (now - cap.startedAt) / 1000)),
        longPauseCount: cap.longPauseCount,
        longestPauseSec: Math.min(3600, cap.longestPauseSec),
      };
      capRef.current = null;
    }
    setRecording(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = ctor();
    if (!Ctor || recRef.current) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    capRef.current = {
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      longPauseCount: 0,
      longestPauseSec: 0,
    };
    rec.onresult = (e) => {
      const now = Date.now();
      const cap = capRef.current;
      if (cap) {
        const gap = (now - cap.lastEventAt) / 1000;
        if (gap > LONG_PAUSE_SEC) {
          cap.longPauseCount += 1;
          cap.longestPauseSec = Math.max(cap.longestPauseSec, gap);
        }
        cap.lastEventAt = now;
      }
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r?.isFinal && r[0]?.transcript) final += r[0].transcript;
      }
      if (final.trim()) onFinalRef.current(final);
    };
    rec.onerror = () => stop();
    rec.onend = () => {
      // recognition can end on its own (silence) — close out the capture
      if (recRef.current === rec) stop();
    };
    recRef.current = rec;
    try {
      rec.start();
      setRecording(true);
    } catch {
      recRef.current = null;
      capRef.current = null;
      setRecording(false);
    }
  }, [stop]);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // drain the metrics captured by the last recording (call at submit)
  const takeMetrics = useCallback((): VoiceMetrics | null => {
    if (recRef.current) stop();
    const m = doneRef.current;
    doneRef.current = null;
    return m;
  }, [stop]);

  useEffect(() => {
    return () => {
      const rec = recRef.current;
      recRef.current = null;
      capRef.current = null;
      try {
        rec?.abort();
      } catch {
        /* noop */
      }
    };
  }, []);

  return { supported: speechSupported(), recording, toggle, takeMetrics };
}

/** Read each new question text aloud; cancel on change/unmount. */
export function useSpeakQuestion(enabled: boolean, text: string | null) {
  useEffect(() => {
    if (!enabled || !text || typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    synth.speak(utter);
    return () => synth.cancel();
  }, [enabled, text]);
}
