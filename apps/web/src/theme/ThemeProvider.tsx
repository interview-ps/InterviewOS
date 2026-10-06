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
  brandTokensFor,
  customPalette,
  DEFAULT_PALETTE,
  DEFAULT_PALETTE_ID,
  findPalette,
  normalizeHexColor,
  palettesStyleSheet,
  resolvePalette,
  type BrandTokens,
  type ThemePalette,
} from "./palettes";
import {
  CUSTOM_COLOR_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  resolveMode,
  THEME_STORAGE_KEY,
  type ThemeMode,
  type ThemePreference,
} from "./tokens";

const PALETTE_STYLE_ID = "interview-palette-styles";

interface ThemeContextValue {
  /** User preference — may be "system". */
  preference: ThemePreference;
  /** Resolved mode actually applied to the DOM. */
  mode: ThemeMode;
  isDark: boolean;
  /** Active palette id ("cobalt"… or "custom"). */
  palette: string;
  /** Resolved palette object for the current id/custom colour. */
  activePalette: ThemePalette;
  /** Custom hex used when `palette === "custom"`. */
  customColor: string | null;
  /** Resolved brand tokens for the current palette × mode (feeds antd). */
  brandTokens: BrandTokens;
  setPreference: (preference: ThemePreference) => void;
  setPalette: (paletteId: string) => void;
  setCustomColor: (hex: string | null) => void;
  /** Cycle light → dark → system. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — keep in-memory */
  }
}

function readPreference(): ThemePreference {
  const stored = readStorage(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function readPalette(): string {
  return readStorage(PALETTE_STORAGE_KEY) ?? DEFAULT_PALETTE_ID;
}

function readCustomColor(): string | null {
  return normalizeHexColor(readStorage(CUSTOM_COLOR_STORAGE_KEY) ?? "");
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Inject/update the single reused stylesheet for all palettes. */
function applyPaletteStyles(customColor: string | null): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(PALETTE_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = PALETTE_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = palettesStyleSheet(customColor);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [mode, setMode] = useState<ThemeMode>(() =>
    resolveMode(readPreference(), prefersDark()),
  );
  const [palette, setPaletteState] = useState<string>(readPalette);
  const [customColor, setCustomColorState] = useState<string | null>(readCustomColor);

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
    writeStorage(THEME_STORAGE_KEY, preference);
  }, [preference]);

  // Reflect the resolved mode on <html> so Tailwind + CSS variables follow.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
  }, [mode]);

  // Reflect the palette axis on <html> and keep the palette stylesheet fresh.
  useEffect(() => {
    document.documentElement.setAttribute("data-palette", palette);
    writeStorage(PALETTE_STORAGE_KEY, palette);
    applyPaletteStyles(customColor);
  }, [palette, customColor]);

  const activePalette = useMemo<ThemePalette>(() => {
    if (palette === "custom") {
      return customColor
        ? customPalette(customColor)
        : findPalette(DEFAULT_PALETTE_ID) ?? DEFAULT_PALETTE;
    }
    return findPalette(palette) ?? DEFAULT_PALETTE;
  }, [palette, customColor]);

  const brandTokens = useMemo(
    () => brandTokensFor(activePalette, mode),
    [activePalette, mode],
  );

  const setPreference = useCallback((p: ThemePreference) => setPreferenceState(p), []);

  const setPalette = useCallback((id: string) => {
    setPaletteState(id === "custom" || findPalette(id) ? id : DEFAULT_PALETTE_ID);
  }, []);

  const setCustomColor = useCallback((hex: string | null) => {
    const normalized = hex ? normalizeHexColor(hex) : null;
    setCustomColorState(normalized);
    writeStorage(CUSTOM_COLOR_STORAGE_KEY, normalized ?? "");
    if (normalized) setPaletteState("custom");
  }, []);

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
      palette,
      activePalette,
      customColor,
      brandTokens,
      setPreference,
      setPalette,
      setCustomColor,
      toggle,
    }),
    [
      preference,
      mode,
      palette,
      activePalette,
      customColor,
      brandTokens,
      setPreference,
      setPalette,
      setCustomColor,
      toggle,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export { resolvePalette };
