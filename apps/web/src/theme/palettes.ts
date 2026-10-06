import type { ThemeMode } from "./tokens";

/**
 * Brand palette axis (Octop "L2").
 *
 * Pure, dependency-free colour math plus a small curated palette registry.
 * A palette changes the brand *hue* only — the mode axis (light/dark) owns the
 * neutral surfaces and the semantic status colours, which must never be
 * recast by a palette.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/* -- colour math ----------------------------------------------------------- */

const HEX3 = /^[0-9a-fA-F]{3}$/;
const HEX6 = /^[0-9a-fA-F]{6}$/;

/** `#ABC`, `abc123`, ` #2563EB ` → `#aabbcc`; anything else → null. */
export function normalizeHexColor(input: string): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().replace(/^#/, "");
  if (HEX3.test(value)) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!HEX6.test(value)) return null;
  return `#${value.toLowerCase()}`;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHexColor(hex);
  if (!normalized) throw new Error(`invalid hex colour: ${hex}`);
  const int = parseInt(normalized.slice(1), 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** `"37, 99, 235"` — the triple used by `rgba(var(--brand-rgb), a)`. */
export function rgbTriple(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
}

export function rgbaString(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix `b` into `a`; weight 0 → a, 1 → b. */
export function mixHex(a: string, b: string, weight: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  });
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Darken `color` (in small steps) until it reaches `min` contrast against `bg`.
 * Used to guarantee white-on-brand buttons and brand text stay AA-legible.
 */
export function ensureSolidOnWhite(
  color: string,
  min = 4.5,
  bg = "#ffffff",
): string {
  let out = color;
  for (let i = 0; i < 24 && contrastRatio(out, bg) < min; i += 1) {
    out = mixHex(out, "#000000", 0.08);
  }
  return out;
}

/* -- registry -------------------------------------------------------------- */

export interface ThemePalette {
  id: string;
  label: string;
  /** Canonical light-mode brand hex. */
  brand: string;
  /** Preview chips: brand, mid tint, soft tint. */
  swatch: readonly [string, string, string];
  custom?: boolean;
}

function swatchFor(brand: string): readonly [string, string, string] {
  return [brand, mixHex(brand, "#ffffff", 0.55), mixHex(brand, "#ffffff", 0.85)];
}

function curated(id: string, label: string, brand: string): ThemePalette {
  return { id, label, brand, swatch: swatchFor(brand) };
}

export const CURATED_PALETTES: readonly ThemePalette[] = Object.freeze([
  curated("cobalt", "Cobalt", "#2563eb"),
  curated("rose", "Rose", "#e85d75"),
  curated("violet", "Violet", "#7c3aed"),
  curated("indigo", "Indigo", "#4f46e5"),
  curated("teal", "Teal", "#0d9488"),
  curated("emerald", "Emerald", "#059669"),
  curated("amber", "Amber", "#d97706"),
  curated("slate", "Slate", "#475569"),
]);

export const DEFAULT_PALETTE_ID = "cobalt";
export const DEFAULT_PALETTE: ThemePalette = CURATED_PALETTES[0]!;
export const CUSTOM_PALETTE_ID = "custom";

export function findPalette(id: string): ThemePalette | undefined {
  return CURATED_PALETTES.find((p) => p.id === id);
}

export function customPalette(hex: string): ThemePalette {
  const brand = normalizeHexColor(hex) ?? DEFAULT_PALETTE.brand;
  return { id: CUSTOM_PALETTE_ID, label: "Custom", brand, swatch: swatchFor(brand), custom: true };
}

export function resolvePalette(id: string, customHex: string | null): ThemePalette {
  if (id === CUSTOM_PALETTE_ID && customHex) return customPalette(customHex);
  return findPalette(id) ?? DEFAULT_PALETTE;
}

/* -- per-palette × mode antd brand tokens ---------------------------------- */

export interface BrandTokens {
  /** antd primary — guaranteed AA against white body text. */
  base: string;
  /** CSS-visible brand for the current mode (text, links, borders, accents). */
  accent: string;
  /** accent as an `r, g, b` triple. */
  rgb: string;
  /** antd primary hover / active. */
  hover: string;
  active: string;
  /** Solid soft background for info pills / selection surfaces. */
  softBg: string;
  hoverBg: string;
  activeBg: string;
  selectedBg: string;
  onBrand: string;
}

const DARK_PAGE = "#0b1220";

export function brandTokensFor(
  palette: ThemePalette,
  mode: ThemeMode,
): BrandTokens {
  const raw = normalizeHexColor(palette.brand) ?? DEFAULT_PALETTE.brand;
  if (mode === "light") {
    const softBg = mixHex(raw, "#ffffff", 0.94);
    // Two passes: white-on-brand (buttons) then brand-on-soft (info text).
    let primary = ensureSolidOnWhite(raw, 4.5, "#ffffff");
    primary = ensureSolidOnWhite(primary, 4.5, softBg);
    return {
      base: primary,
      accent: primary,
      rgb: rgbTriple(primary),
      hover: mixHex(primary, "#000000", 0.12),
      active: mixHex(primary, "#000000", 0.24),
      softBg,
      hoverBg: rgbaString(primary, 0.05),
      activeBg: rgbaString(primary, 0.08),
      selectedBg: rgbaString(primary, 0.06),
      onBrand: "#ffffff",
    };
  }
  const softBg = mixHex(raw, DARK_PAGE, 0.82);
  const base = ensureSolidOnWhite(raw, 4.5, "#ffffff");
  const accent = ensureSolidOnWhite(mixHex(raw, "#ffffff", 0.32), 4.5, softBg);
  return {
    base,
    accent,
    rgb: rgbTriple(accent),
    hover: mixHex(base, "#ffffff", 0.12),
    active: mixHex(base, "#ffffff", 0.24),
    softBg,
    hoverBg: rgbaString(accent, 0.1),
    activeBg: rgbaString(accent, 0.16),
    selectedBg: rgbaString(accent, 0.12),
    onBrand: "#ffffff",
  };
}

/* -- CSS generation -------------------------------------------------------- */

/** The brand-related custom properties a palette overrides. */
export function paletteCssVars(
  palette: ThemePalette,
  mode: ThemeMode,
): Record<string, string> {
  const t = brandTokensFor(palette, mode);
  const hover = mode === "light" ? t.hover : mixHex(t.accent, "#ffffff", 0.12);
  const active = mode === "light" ? t.active : mixHex(t.accent, "#ffffff", 0.24);
  return {
    "--color-blue": t.accent,
    "--color-blue-hover": hover,
    "--color-blue-active": active,
    "--color-tint": t.selectedBg,
    "--color-hover": t.hoverBg,
    "--brand-rgb": t.rgb,
    "--tint-hover": t.hoverBg,
    "--tint-active": t.activeBg,
    "--tint-selected": t.selectedBg,
    "--interview-brand": t.accent,
    "--interview-brand-hover": hover,
    "--interview-brand-active": active,
    "--interview-brand-rgb": t.rgb,
    "--interview-selection": t.softBg,
    "--interview-info": t.accent,
    "--interview-info-bg": t.softBg,
  };
}

/** Light-mode variables for a user-supplied hex (used by the picker preview). */
export function customPaletteCssVars(hex: string): Record<string, string> {
  return paletteCssVars(customPalette(hex), "light");
}

function rule(palette: ThemePalette, mode: ThemeMode, selector: string): string {
  const vars = paletteCssVars(palette, mode);
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `${selector} {\n${body}\n}`;
}

/**
 * The full runtime stylesheet: one light + one dark rule per curated palette,
 * plus the custom slot when a hex is configured. Injected once by the theme
 * provider into a single reused `<style>` element.
 */
export function palettesStyleSheet(customHex?: string | null): string {
  const rules: string[] = [];
  for (const p of CURATED_PALETTES) {
    rules.push(rule(p, "light", `html[data-palette="${p.id}"]`));
    rules.push(
      rule(p, "dark", `html[data-theme="dark"][data-palette="${p.id}"]`),
    );
  }
  if (customHex && normalizeHexColor(customHex)) {
    const custom = customPalette(customHex);
    rules.push(rule(custom, "light", `html[data-palette="${CUSTOM_PALETTE_ID}"]`));
    rules.push(
      rule(custom, "dark", `html[data-theme="dark"][data-palette="${CUSTOM_PALETTE_ID}"]`),
    );
  }
  return rules.join("\n");
}

/* -- contrast audit -------------------------------------------------------- */

export interface ContrastRow {
  palette: string;
  mode: ThemeMode;
  whiteOnBrand: number;
  brandOnSoft: number;
}

/**
 * Every palette × mode must keep white-on-brand ≥ 4.5:1 (buttons) and the
 * brand text on its own soft background ≥ 4.5:1. Returns the full table.
 */
export function contrastAudit(palettes: readonly ThemePalette[] = CURATED_PALETTES): ContrastRow[] {
  const rows: ContrastRow[] = [];
  for (const p of palettes) {
    for (const mode of ["light", "dark"] as const) {
      const t = brandTokensFor(p, mode);
      rows.push({
        palette: p.id,
        mode,
        whiteOnBrand: contrastRatio("#ffffff", t.base),
        brandOnSoft: contrastRatio(t.accent, t.softBg),
      });
    }
  }
  return rows;
}

export const CONTRAST_MIN = 4.5;

export function contrastPasses(row: ContrastRow): boolean {
  return row.whiteOnBrand >= CONTRAST_MIN && row.brandOnSoft >= CONTRAST_MIN;
}
