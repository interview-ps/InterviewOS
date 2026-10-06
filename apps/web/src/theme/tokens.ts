import { theme as uiTheme } from "@interview-os/ui";

export type ThemeMode = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "interview-os:theme";
/** Palette axis storage (curated palette id, or "custom"). */
export const PALETTE_STORAGE_KEY = "interview-os:palette";
export const CUSTOM_COLOR_STORAGE_KEY = "interview-os:custom-color";

/** Interview OS brand anchors (single source: @interview-os/ui tokens). */
export const brand = {
  navy: uiTheme.colors.navy,
  blue: uiTheme.colors.blue,
  blueHover: uiTheme.colors.blueHover,
  accent: uiTheme.colors.accent,
  green: uiTheme.colors.green,
  danger: uiTheme.colors.danger,
} as const;

export interface SemanticTokens {
  bg: string;
  bgContainer: string;
  bgElevated: string;
  bgLayout: string;
  inset: string;
  surfaceHover: string;
  selection: string;
  textPrimary: string;
  textBody: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderSecondary: string;
  divider: string;
  brand: string;
  brandHover: string;
  brandActive: string;
  link: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  neutral: string;
  neutralBg: string;
  radiusXs: number;
  radiusSm: number;
  radiusMd: number;
  radiusLg: number;
  shadowSm: string;
  shadowMd: string;
  controlHeight: number;
  fontBody: string;
  fontDisplay: string;
}

/**
 * Semantic product tokens. Values mirror `theme/variables.css`; the light set
 * is the current Interview OS identity, the dark set derives from the same
 * neutral/cobalt hues.
 */
export const semanticTokens: Record<ThemeMode, SemanticTokens> = {
  light: {
    bg: "#f6f7f9",
    bgContainer: "#ffffff",
    bgElevated: "#ffffff",
    bgLayout: "#f6f7f9",
    inset: "#f8fafc",
    surfaceHover: "#f2f4f7",
    selection: "#eff6ff",
    textPrimary: "#172033",
    textBody: "#344054",
    textSecondary: "#475467",
    textMuted: "#667085",
    border: "#d0d5dd",
    borderSecondary: "#e4e7ec",
    divider: "#e4e7ec",
    brand: uiTheme.colors.blue,
    brandHover: uiTheme.colors.blueHover,
    brandActive: uiTheme.colors.blueActive,
    link: uiTheme.colors.blue,
    success: uiTheme.colors.green,
    successBg: uiTheme.colors.greenTint,
    warning: uiTheme.colors.accent,
    warningBg: uiTheme.colors.accentTint,
    danger: uiTheme.colors.danger,
    dangerBg: uiTheme.colors.dangerTint,
    neutral: uiTheme.colors.neutral,
    neutralBg: uiTheme.colors.neutralTint,
    radiusXs: 5,
    radiusSm: 8,
    radiusMd: 10,
    radiusLg: 12,
    shadowSm: "0 1px 3px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.04)",
    shadowMd: "0 12px 28px -8px rgba(16, 24, 40, 0.16)",
    controlHeight: 32,
    fontBody: uiTheme.fonts.body,
    fontDisplay: uiTheme.fonts.display,
  },
  dark: {
    bg: "#0b1220",
    bgContainer: "#111827",
    bgElevated: "#1a2233",
    bgLayout: "#0b1220",
    inset: "#0f1726",
    surfaceHover: "#1c2536",
    selection: "#16233d",
    textPrimary: "#e6ebf5",
    textBody: "#cbd3e1",
    textSecondary: "#9aa7bd",
    textMuted: "#7c8aa3",
    border: "#2a3345",
    borderSecondary: "#1e2739",
    divider: "#1e2739",
    brand: "#5b8def",
    brandHover: "#78a2f2",
    brandActive: "#4a7be0",
    link: "#78a2f2",
    success: "#4ade80",
    successBg: "#122b1d",
    warning: "#fbbf24",
    warningBg: "#2b230f",
    danger: "#f87171",
    dangerBg: "#2c1518",
    neutral: "#9aa7bd",
    neutralBg: "#1b2334",
    radiusXs: 5,
    radiusSm: 8,
    radiusMd: 10,
    radiusLg: 12,
    shadowSm: "0 1px 3px rgba(0, 0, 0, 0.45), 0 1px 2px rgba(0, 0, 0, 0.3)",
    shadowMd: "0 16px 36px -16px rgba(0, 0, 0, 0.7)",
    controlHeight: 32,
    fontBody: uiTheme.fonts.body,
    fontDisplay: uiTheme.fonts.display,
  },
};

export function resolveMode(
  preference: ThemePreference,
  prefersDark: boolean,
): ThemeMode {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}
