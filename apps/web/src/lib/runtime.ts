export type RuntimeMode = "codex" | "mock" | "claude" | "opencode";

const LABELS: Record<RuntimeMode, string> = {
  codex: "Codex",
  mock: "Mock",
  claude: "Claude Code",
  opencode: "opencode",
};

export function runtimeLabel(mode: string): string {
  return LABELS[mode as RuntimeMode] ?? mode;
}
