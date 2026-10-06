import { useEffect, useState } from "react";

import { CURATED_PALETTES, customPalette, normalizeHexColor } from "@/theme/palettes";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemePreference } from "@/theme/tokens";
import { SettingRow } from "@/components/ui";

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
];

/**
 * Appearance controls: the mode axis (light/dark/system) beside the palette
 * axis (curated swatches + a custom hex with live preview). Both are persisted
 * by ThemeProvider.
 */
export function AppearanceSettings() {
  const { preference, setPreference, palette, setPalette, customColor, setCustomColor } =
    useTheme();
  const [hex, setHex] = useState(customColor ?? "#2563eb");
  const preview = normalizeHexColor(hex);

  useEffect(() => {
    if (customColor) setHex(customColor);
  }, [customColor]);

  return (
    <section data-testid="appearance-settings">
      <h2 className="mb-1 text-sm font-semibold text-navy">Appearance</h2>

      <SettingRow
        label="Theme"
        description="Light, dark, or follow your system."
        control={
          <div
            role="group"
            aria-label="Theme"
            className="inline-flex overflow-hidden rounded-[var(--radius-sm)] border border-line"
          >
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                aria-pressed={preference === o.key}
                onClick={() => setPreference(o.key)}
                className={`px-2.5 py-1 text-[13px] ${
                  preference === o.key
                    ? "bg-[var(--color-tint)] font-medium text-[var(--color-blue-hover)]"
                    : "text-muted hover:bg-[var(--color-hover)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
      />

      <SettingRow
        label="Brand palette"
        description="Recolours links, primary actions and selection. Status colours never change."
        control={
          <div
            role="group"
            aria-label="Brand palette"
            className="flex flex-wrap items-center gap-1.5"
            data-testid="palette-swatches"
          >
            {CURATED_PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.label}
                aria-label={p.label}
                aria-pressed={palette === p.id}
                data-palette-id={p.id}
                onClick={() => setPalette(p.id)}
                className={`h-6 w-6 rounded-full border ${
                  palette === p.id
                    ? "border-transparent ring-2 ring-[color:var(--color-blue)] ring-offset-1 ring-offset-[var(--color-surface)]"
                    : "border-line"
                }`}
                style={{ background: p.brand }}
              />
            ))}
          </div>
        }
      />

      <SettingRow
        label="Custom colour"
        description="Any hex value; the palette is derived and contrast-checked."
        control={
          <div className="flex items-center gap-2">
            <input
              value={hex}
              onChange={(e) => {
                setHex(e.target.value);
                const normalized = normalizeHexColor(e.target.value);
                if (normalized) setCustomColor(normalized);
              }}
              aria-label="Custom brand colour"
              placeholder="#2563eb"
              data-testid="custom-colour"
              className="w-32 rounded-[var(--radius-sm)] border border-line px-2 py-1 font-mono text-xs"
            />
            <span
              aria-hidden
              data-testid="custom-colour-preview"
              className="h-6 w-6 rounded-full border border-line"
              style={{ background: preview ?? customPalette("#2563eb").brand }}
            />
          </div>
        }
      />
    </section>
  );
}
