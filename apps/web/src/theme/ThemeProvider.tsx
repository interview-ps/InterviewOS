import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  resolveMode,
  THEME_STORAGE_KEY,
  type ThemeMode,
  type ThemePreference,
} from "./tokens";

interface ThemeContextValue {
  /** User preference — may be "system". */
  preference: ThemePreference;
  /** Resolved mode actually applied to the DOM. */
  mode: ThemeMode;
  isDark: boolean;
  setPreference: (preference: ThemePreference) => void;
  /** Cycle light → dark → system. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    /* storage unavailable — fall through */
  }
  return "system";
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [mode, setMode] = useState<ThemeMode>(() =>
    resolveMode(readPreference(), prefersDark()),
  );

  // Track the OS preference while the user has chosen "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (preference === "system") setMode(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  useEffect(() => {
    setMode(resolveMode(preference, prefersDark()));
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      /* ignore */
    }
  }, [preference]);

  // Reflect the resolved mode on <html> so Tailwind + CSS variables follow.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
  }, [mode]);

  const setPreference = useCallback((p: ThemePreference) => setPreferenceState(p), []);
  const toggle = useCallback(
    () =>
      setPreferenceState((prev) =>
        prev === "light" ? "dark" : prev === "dark" ? "system" : "light",
      ),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      mode,
      isDark: mode === "dark",
      setPreference,
      toggle,
    }),
    [preference, mode, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
