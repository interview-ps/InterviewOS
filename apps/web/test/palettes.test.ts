import { describe, expect, it } from "vitest";

import {
  CONTRAST_MIN,
  CURATED_PALETTES,
  brandTokensFor,
  contrastAudit,
  contrastPasses,
  contrastRatio,
  customPalette,
  customPaletteCssVars,
  ensureSolidOnWhite,
  mixHex,
  normalizeHexColor,
  palettesStyleSheet,
} from "../src/theme/palettes";

describe("normalizeHexColor", () => {
  it("expands shorthand and normalizes case", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor("abc123")).toBe("#abc123");
    expect(normalizeHexColor("  #2563EB ")).toBe("#2563eb");
  });

  it("rejects anything that is not a 3/6 digit hex", () => {
    expect(normalizeHexColor("nope")).toBeNull();
    expect(normalizeHexColor("#12345")).toBeNull();
    expect(normalizeHexColor("")).toBeNull();
  });
});

describe("mixHex", () => {
  it("returns the endpoints at weight 0 and 1", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("blends the midpoint", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("contrastRatio", () => {
  it("spans 1–21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("ensureSolidOnWhite", () => {
  it("darkens a light brand until it is AA against white", () => {
    const fixed = ensureSolidOnWhite("#e85d75");
    expect(contrastRatio("#ffffff", fixed)).toBeGreaterThanOrEqual(CONTRAST_MIN);
    expect(fixed).not.toBe("#e85d75");
  });

  it("leaves an already-dark colour untouched", () => {
    expect(ensureSolidOnWhite("#0b1220")).toBe("#0b1220");
  });
});

describe("brandTokensFor", () => {
  it("keeps white-on-brand and brand-on-soft AA for every palette × mode", () => {
    const failures = contrastAudit().filter((row) => !contrastPasses(row));
    expect(failures).toEqual([]);
  });

  it("separates the button primary from the mode accent in dark mode", () => {
    const tokens = brandTokensFor(CURATED_PALETTES[0]!, "dark");
    expect(tokens.onBrand).toBe("#ffffff");
    expect(contrastRatio("#ffffff", tokens.base)).toBeGreaterThanOrEqual(CONTRAST_MIN);
  });
});

describe("custom palette", () => {
  it("normalizes the hex and exposes light css vars", () => {
    const palette = customPalette("#ABC");
    expect(palette.brand).toBe("#aabbcc");
    expect(palette.custom).toBe(true);
    const vars = customPaletteCssVars("#ABC");
    expect(vars["--interview-brand"]).toBeDefined();
    expect(vars["--brand-rgb"]).toBeDefined();
  });
});

describe("palettesStyleSheet", () => {
  it("emits light and dark rules for every curated palette", () => {
    const css = palettesStyleSheet();
    for (const p of CURATED_PALETTES) {
      expect(css).toContain(`html[data-palette="${p.id}"]`);
      expect(css).toContain(`html[data-theme="dark"][data-palette="${p.id}"]`);
    }
    expect(css).not.toContain('data-palette="custom"');
  });

  it("adds the custom slot only for a valid hex", () => {
    expect(palettesStyleSheet("#abcdef")).toContain('data-palette="custom"');
    expect(palettesStyleSheet("nope")).not.toContain('data-palette="custom"');
  });
});
