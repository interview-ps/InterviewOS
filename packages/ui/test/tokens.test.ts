import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { theme } from "../src/tokens.js";

const css = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/theme.css"),
  "utf8",
);

function cssVar(name: string): string | undefined {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m?.[1]?.trim();
}

describe("tokens.ts ↔ theme.css sync", () => {
  it("colors match", () => {
    const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const [key, value] of Object.entries(theme.colors)) {
      expect(cssVar(`color-${kebab(key)}`), key).toBe(value);
    }
    expect(theme.primary).toBe(theme.colors.blue);
  });

  it("fonts, radius and breakpoint match", () => {
    expect(cssVar("font-display")).toBe(theme.fonts.display);
    expect(cssVar("font-body")).toBe(theme.fonts.body);
    expect(cssVar("radius-card")).toBe(theme.radius.card);
    expect(cssVar("radius-sm")).toBe(theme.radius.sm);
    expect(cssVar("breakpoint-menu")).toBe(theme.breakpoint.menu);
  });

  it("compact spacing and sizes match", () => {
    const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const [key, value] of Object.entries(theme.space)) {
      expect(cssVar(`space-${key}`), key).toBe(value);
    }
    for (const [key, value] of Object.entries(theme.size)) {
      expect(cssVar(`size-${kebab(key)}`), key).toBe(value);
    }
  });
});
