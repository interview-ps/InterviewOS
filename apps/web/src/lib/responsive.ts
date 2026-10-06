import { Grid } from "antd";

/**
 * True on the desktop shell (`lg` ≥ 992px) — the same cutoff `.interview-split`
 * and the sidebar use. Reserved for places where component *behavior* must
 * change (list/detail switching, drawers). Prefer responsive CSS / Row / Col
 * for ordinary layout changes.
 */
export function useDesktop(): boolean {
  const screens = Grid.useBreakpoint();
  return screens.lg ?? true;
}
