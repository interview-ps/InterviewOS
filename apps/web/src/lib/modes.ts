import { useEffect, useState } from "react";
import { api, type AvailableMode } from "@/lib/api";

let cache: AvailableMode[] | null = null;
let inflight: Promise<AvailableMode[]> | null = null;

/**
 * v1: interview modes available for new sessions (GET /api/modes) — plugin
 * modes appear while their plugin is enabled, unavailable modes are absent.
 */
export function useAvailableModes(): AvailableMode[] {
  const [list, setList] = useState<AvailableMode[]>(cache ?? []);
  useEffect(() => {
    let cancelled = false;
    inflight ??= api
      .modes()
      .then((r) => (cache = r.modes))
      .catch(() => (cache = []));
    void inflight.then((v) => {
      if (!cancelled) setList(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

/** Force the next useAvailableModes call to refetch (plugin toggles). */
export function refreshModes(): void {
  cache = null;
  inflight = null;
}

/** Historical default picks — preferred when the plugins providing them are enabled. */
const PREFERRED_MODE_IDS = ["technical", "behavioral"];

/**
 * A mode id for a control default: the preferred id when available, else the
 * first listed mode, else "mixed" (the core fallback round).
 */
export function defaultModeId(
  modes: AvailableMode[],
  preferred = "technical",
): string {
  return modes.find((m) => m.id === preferred)?.id ?? modes[0]?.id ?? "mixed";
}

/**
 * Round modes for a loop/pack skeleton: the preferred pair first, then filled
 * from list order up to `count` (may return fewer when plugins are disabled).
 */
export function defaultRoundModes(
  modes: AvailableMode[],
  count = 2,
): AvailableMode[] {
  const picks: AvailableMode[] = [];
  for (const id of PREFERRED_MODE_IDS) {
    const m = modes.find((x) => x.id === id);
    if (m) picks.push(m);
  }
  for (const m of modes) {
    if (picks.length >= count) break;
    if (!picks.includes(m)) picks.push(m);
  }
  return picks;
}
