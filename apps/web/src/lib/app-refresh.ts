import { createContext, useContext } from "react";

/**
 * Shell-provided "reload the current view" doorbell. Switching the active
 * target used to call `window.location.reload()`; instead the shell bumps a key
 * on the routed content so pages refetch on mount, keeping SPA state intact.
 */
export const AppRefreshContext = createContext<() => void>(() => {});

export function useAppRefresh(): () => void {
  return useContext(AppRefreshContext);
}
