import { createContext, useContext, useEffect, useRef } from "react";

type RefreshListener = () => void;

/**
 * Shell-provided "reload the current view" doorbell. Switching the active
 * target (or running a command-palette action) used to remount the routed
 * content via a React key; instead the shell broadcasts a refresh and each page
 * subscribes and refetches, so local UI state survives.
 */
export interface AppRefreshApi {
  /** Broadcast a refresh to every subscribed page. */
  refresh: () => void;
  /** Subscribe to refresh events; returns an unsubscribe function. */
  subscribe: (listener: RefreshListener) => () => void;
}

export const AppRefreshContext = createContext<AppRefreshApi>({
  refresh: () => {},
  subscribe: () => () => {},
});

/** The broadcast trigger, for callers (target switcher, command palette, mutations). */
export function useAppRefresh(): () => void {
  return useContext(AppRefreshContext).refresh;
}

/**
 * Re-run `effect` whenever the shell broadcasts a refresh. The latest closure is
 * invoked, so it can capture current page state without re-subscribing.
 */
export function useAppRefreshEffect(effect: () => void): void {
  const { subscribe } = useContext(AppRefreshContext);
  const latest = useRef(effect);
  useEffect(() => {
    latest.current = effect;
  });
  useEffect(() => subscribe(() => latest.current()), [subscribe]);
}
