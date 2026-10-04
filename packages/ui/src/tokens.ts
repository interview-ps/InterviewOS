/**
 * Design tokens — the single typed source for the values in `theme.css`.
 * `test/tokens.test.ts` asserts the two stay in sync.
 */
export const theme = {
  colors: {
    navy: "#012970",
    blue: "#1647a5",
    blueHover: "#092e75",
    accent: "#b45309",
    green: "#236342",
    greenTint: "#e8f5ec",
    ink: "#172033",
    muted: "#4b556b",
    line: "#d9e0ed",
    page: "#f5f7fb",
    surface: "#ffffff",
    tint: "#eef3fc",
    weak: "#b45309",
    danger: "#9f1239",
  },
  /** primary = brand blue used for primary buttons/accents */
  primary: "#1647a5",
  fonts: {
    display: "var(--font-jakarta), ui-sans-serif, system-ui, sans-serif",
    body: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  },
  radius: {
    card: "1rem",
    sm: "0.6rem",
  },
  spacing: {
    sm: "0.6rem",
    md: "1rem",
    lg: "1.25rem",
  },
  breakpoint: {
    menu: "900px",
  },
} as const;

export type Theme = typeof theme;
