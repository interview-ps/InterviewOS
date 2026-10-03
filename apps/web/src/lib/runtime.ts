export type RuntimeMode = "codex" | "mock" | "claude" | "opencode" | "devin";

const LABELS: Record<RuntimeMode, string> = {
  codex: "Codex",
  mock: "Mock",
  claude: "Claude Code",
  opencode: "opencode",
  devin: "Devin",
};

export function runtimeLabel(mode: string): string {
  return LABELS[mode as RuntimeMode] ?? mode;
}
