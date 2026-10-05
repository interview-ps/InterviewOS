"""Voice mode delivery hints — port of `interview/voice.ts`.

All metrics are client-measured and all counts are recomputed server-side from
the transcript; nothing here feeds evaluation or evidence.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from .js_compat import js_round, number_to_string
from .models.interview import (
    VOICE_DISCLAIMER,
    VoiceFeedback,
    VoiceMetrics,
    VoiceSignal,
    VoiceSignalId,
    VoiceSignalStatus,
)

__all__ = [
    "VOICE_DISCLAIMER",
    "VoiceFeedback",
    "VoiceMetrics",
    "VoiceSignal",
    "count_fillers",
    "voice_feedback",
]

_FILLER_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(um+|uh+|erm+|er+)\b", re.IGNORECASE),
    re.compile(r"\b(you know|i mean)\b", re.IGNORECASE),
    re.compile(r"\b(sort of|kind of)\b", re.IGNORECASE),
    # "like" is a real word — only count it as a filler when it clearly isn't a
    # verb/preposition: pausal ("… like, …"), comma-delimited, or clause-initial.
    re.compile(r"\blike,|(?:^|[,.;]\s*)like[,.]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"(?:^|[,.;]\s*)(basically|actually|literally)\b", re.IGNORECASE | re.MULTILINE),
)

_SEQUENCING = re.compile(
    r"\b(first|firstly|then|next|after that|finally|situation|task|action|result|in the end)\b",
    re.IGNORECASE,
)
_CONCLUSION = re.compile(
    r"\b(so,|so |in summary|to summarize|as a result|overall|ultimately|which led to|"
    r"that's why|in the end|\d+(\.\d+)?%)",
    re.IGNORECASE,
)


def count_fillers(text: str) -> int:
    """Rough spoken-filler count; heuristic only."""

    count = 0
    for pattern in _FILLER_PATTERNS:
        count += len(pattern.findall(text))
    return count


def _words(text: str) -> list[str]:
    return [word for word in re.split(r"\s+", text.strip()) if word]


def _sentences(text: str) -> list[str]:
    return [s for s in (part.strip() for part in re.split(r"[.!?]+\s+|[.!?]+\Z", text)) if s]


def voice_feedback(metrics: VoiceMetrics | Mapping[str, object], transcript: str) -> VoiceFeedback:
    """Deterministic delivery-hint signals from metrics + transcript."""

    parsed = metrics if isinstance(metrics, VoiceMetrics) else VoiceMetrics.model_validate(metrics)
    word_count = len(_words(transcript))
    filler_count = count_fillers(transcript)
    sentences = _sentences(transcript)
    words_per_minute = (
        int(js_round((word_count / parsed.duration_sec) * 60))
        if parsed.duration_sec >= 10
        else None
    )

    signals: list[VoiceSignal] = []

    structure_watch = (word_count > 120 and len(sentences) < 3) or (
        word_count > 200 and not _SEQUENCING.search(transcript)
    )
    signals.append(
        VoiceSignal(
            id=VoiceSignalId.STRUCTURE,
            status=VoiceSignalStatus.WATCH if structure_watch else VoiceSignalStatus.OK,
            message=(
                "Hard to follow — break the answer into more sentences or use sequencing "
                "markers (first / then / finally)."
                if structure_watch
                else "Answer reads as structured."
            ),
        )
    )

    filler_watch = word_count > 0 and (filler_count / word_count) * 100 > 6
    signals.append(
        VoiceSignal(
            id=VoiceSignalId.FILLER,
            status=VoiceSignalStatus.WATCH if filler_watch else VoiceSignalStatus.OK,
            message=(
                f"{filler_count} filler words in {word_count} words — pause silently "
                "instead of filling."
                if filler_watch
                else "Filler usage is within a normal range."
            ),
        )
    )

    pause_watch = parsed.long_pause_count >= 3 or parsed.longest_pause_sec > 8
    signals.append(
        VoiceSignal(
            id=VoiceSignalId.PAUSES,
            status=VoiceSignalStatus.WATCH if pause_watch else VoiceSignalStatus.OK,
            message=(
                f"{parsed.long_pause_count} long pause(s), longest "
                f"{number_to_string(parsed.longest_pause_sec)}s — practice a bridging phrase."
                if pause_watch
                else "Pacing looks comfortable."
            ),
        )
    )

    length_watch = parsed.duration_sec > 180 or word_count > 450
    signals.append(
        VoiceSignal(
            id=VoiceSignalId.LENGTH,
            status=VoiceSignalStatus.WATCH if length_watch else VoiceSignalStatus.OK,
            message=(
                "Long answer — aim for ~2 minutes; lead with the headline, then detail."
                if length_watch
                else "Length is within a good range."
            ),
        )
    )

    tail = " ".join(sentences[-2:])
    conclusion_watch = word_count >= 40 and not _CONCLUSION.search(tail)
    signals.append(
        VoiceSignal(
            id=VoiceSignalId.CONCLUSION,
            status=VoiceSignalStatus.WATCH if conclusion_watch else VoiceSignalStatus.OK,
            message=(
                "No clear wrap-up — end on the result or a one-line takeaway."
                if conclusion_watch
                else "Answer lands on a conclusion."
            ),
        )
    )

    mean_sentence = word_count / len(sentences) if sentences else 0
    clarity_watch = mean_sentence > 35
    signals.append(
        VoiceSignal(
            id=VoiceSignalId.CLARITY,
            status=VoiceSignalStatus.WATCH if clarity_watch else VoiceSignalStatus.OK,
            message=(
                f"Average sentence is {int(js_round(mean_sentence))} words — shorter sentences "
                "sound clearer."
                if clarity_watch
                else "Sentences are easy to parse."
            ),
        )
    )

    return VoiceFeedback(
        signals=signals,
        word_count=word_count,
        filler_count=filler_count,
        words_per_minute=words_per_minute,
        disclaimer=VOICE_DISCLAIMER,
    )
