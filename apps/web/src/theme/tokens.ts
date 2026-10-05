import { theme as uiTheme } from "@interview-os/ui";

export type ThemeMode = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "interview-os:theme";

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
  surfaceHover: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderSecondary: string;
  brand: string;
  brandHover: string;
  brandActive: string;
  link: string;
  success: string;
  warning: string;
  danger: string;
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
 * is the existing Interview OS identity, the dark set derives from the same
 * navy/blue hues.
 */
export const semanticTokens: Record<ThemeMode, SemanticTokens> = {
  light: {
    bg: "#f5f7fb",
    bgContainer: "#ffffff",
    bgElevated: "#ffffff",
    bgLayout: "#f5f7fb",
    surfaceHover: "#eef3fc",
    textPrimary: "#172033",
    textSecondary: "#4b556b",
    textMuted: "#6b7488",
    border: "#d9e0ed",
    borderSecondary: "#e8edf7",
    brand: uiTheme.colors.blue,
    brandHover: uiTheme.colors.blueHover,
    brandActive: uiTheme.colors.navy,
    link: uiTheme.colors.blue,
    success: uiTheme.colors.green,
    warning: uiTheme.colors.accent,
    danger: uiTheme.colors.danger,
    radiusSm: 6,
    radiusMd: 10,
    radiusLg: 16,
    shadowSm: "0 1px 3px rgba(1, 41, 112, 0.06), 0 1px 2px rgba(1, 41, 112, 0.04)",
    shadowMd: "0 8px 24px -12px rgba(1, 41, 112, 0.18)",
    controlHeight: 36,
    fontBody: uiTheme.fonts.body,
    fontDisplay: uiTheme.fonts.display,
  },
  dark: {
    bg: "#080e18",
    bgContainer: "#111a2e",
    bgElevated: "#16223b",
    bgLayout: "#080e18",
    surfaceHover: "#17223a",
    textPrimary: "#e7ecf5",
    textSecondary: "#a6b0c3",
    textMuted: "#737f95",
    border: "#26324b",
    borderSecondary: "#1c2740",
    brand: "#5b86e6",
    brandHover: "#7ea1ee",
    brandActive: "#3f66c9",
    link: "#7ea1ee",
    success: "#48b878",
    warning: "#e2a253",
    danger: "#e2607a",
    radiusSm: 6,
    radiusMd: 10,
    radiusLg: 16,
    shadowSm: "0 1px 3px rgba(0, 0, 0, 0.4)",
    shadowMd: "0 12px 32px -16px rgba(0, 0, 0, 0.6)",
    controlHeight: 36,
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
