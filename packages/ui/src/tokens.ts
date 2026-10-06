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
    card: "0.375rem",
    sm: "0.25rem",
  },
  /** Compact spacing scale — desktop-density rhythm. */
  spacing: {
    xs: "0.25rem",
    sm: "0.375rem",
    md: "0.5rem",
    lg: "0.75rem",
    xl: "1rem",
  },
  /** Fixed component sizes for the desktop shell and panes. */
  size: {
    header: "42px",
    siderExpanded: "184px",
    siderCollapsed: "48px",
    navItem: "32px",
    toolbar: "40px",
    row: "32px",
    rowTwoLine: "48px",
    control: "30px",
    inspector: "240px",
  },
  breakpoint: {
    menu: "900px",
  },
} as const;

export type Theme = typeof theme;
