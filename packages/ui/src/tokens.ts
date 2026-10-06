/**
 * Design tokens — the single typed source for the values in `theme.css`.
 * `test/tokens.test.ts` asserts the two stay in sync.
 */
export const theme = {
  colors: {
    /* surfaces */
    page: "#f6f7f9",
    surface: "#ffffff",
    inset: "#f8fafc",
    tint: "#eff6ff",
    hover: "#f2f4f7",
    /* text */
    navy: "#172033",
    ink: "#344054",
    muted: "#667085",
    /* lines */
    line: "#e4e7ec",
    divider: "#e4e7ec",
    control: "#d0d5dd",
    /* brand */
    blue: "#2563eb",
    blueHover: "#1d4ed8",
    blueActive: "#1e40af",
    amber: "#d97706",
    /* semantic status pairs */
    green: "#166534",
    greenTint: "#f0fdf4",
    accent: "#92400e",
    accentTint: "#fffbeb",
    danger: "#b42318",
    dangerTint: "#fef3f2",
    neutral: "#475467",
    neutralTint: "#f2f4f7",
    weak: "#92400e",
  },
  /** primary = brand blue used for primary buttons/accents */
  primary: "#2563eb",
  fonts: {
    display: "var(--font-jakarta), ui-sans-serif, system-ui, sans-serif",
    body: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  },
  radius: {
    sm: "4px",
    md: "6px",
    card: "8px",
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
    control: "32px",
    inspector: "240px",
  },
  breakpoint: {
    menu: "900px",
  },
} as const;

export type Theme = typeof theme;
