import { useNavigate } from "react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type PluginUIContributionView,
  type PrepAction,
  type RoundType,
  type SkillReadiness,
  type TargetListItem,
} from "@/lib/api";
import { runUIAction } from "@/lib/plugin-actions";
import { fuzzyFilter } from "@/lib/fuzzy";
import { skillLabel } from "@/components/ui";

interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => Promise<void> | void;
}

const MODES: { id: RoundType; label: string }[] = [
  { id: "technical", label: "Technical" },
  { id: "coding", label: "Coding" },
  { id: "system_design", label: "System design" },
  { id: "behavioral", label: "Behavioral" },
  { id: "hiring_manager", label: "Hiring manager" },
  { id: "hr", label: "HR" },
];

const LISTBOX_ID = "command-palette-listbox";

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [actions, setActions] = useState<PrepAction[]>([]);
  const [graph, setGraph] = useState<Record<string, SkillReadiness>>({});
  const [pluginUI, setPluginUI] = useState<PluginUIContributionView[]>([]);

  // Load dynamic command sources each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setError(null);
    api.listTargets().then(setTargets).catch(() => setTargets([]));
    api.preparation().then((p) => setActions(p.actions)).catch(() => setActions([]));
    api.readiness().then((g) => setGraph(g.dimensions)).catch(() => setGraph({}));
    api.uiContributions().then((r) => setPluginUI(r.contributions)).catch(() => setPluginUI([]));
    inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const m of MODES) {
      const roundType = m.id;
      list.push({
        id: `interview-${m.id}`,
        title: `Start ${m.label.toLowerCase()} interview`,
        hint: "Interview",
        run: async () => {
          const r = await api.startInterview({ roundType });
          if (r.session) navigate(`/interview/${r.session.id}`);
        },
      });
    }
    list.push({
      id: "loop",
      title: "Start full loop",
      hint: "Interview",
      run: async () => {
        const r = await api.startLoop();
        navigate(`/interview/loop/${r.loop.id}`);
      },
    });
    list.push(
      {
        id: "analyze-jd",
        title: "Analyze new job description",
        hint: "Target",
        run: () => navigate("/target#add-target"),
      },
      {
        id: "weak-answers",
        title: "Review weak answers",
        hint: "History",
        run: () => navigate("/history?weakOnly=1"),
      },
      {
        id: "resume-open",
        title: "Open resume coach",
        hint: "Resume",
        run: () => navigate("/resume"),
      },
      {
        id: "resume-review",
        title: "Run resume review",
        hint: "Resume",
        run: async () => {
          await api.reviewResume();
          navigate("/resume");
        },
      },
      {
        id: "packs",
        title: "Packs",
        hint: "Navigation",
        run: () => navigate("/packs"),
      },
      {
        id: "plugins",
        title: "Plugins",
        hint: "Navigation",
        run: () => navigate("/skills"),
      },
      {
        id: "export-data",
        title: "Export data",
        hint: "Settings",
        run: () => navigate("/settings#data"),
      },
      {
        id: "settings",
        title: "Open settings",
        hint: "Settings",
        run: () => navigate("/settings"),
      },
      {
        id: "codex-check",
        title: "Check Codex connection",
        hint: "Settings",
        run: async () => {
          await api.runtimeCheck();
          navigate("/settings");
        },
      },
    );

    for (const a of actions.filter(
      (x) => x.status === "open" || x.status === "in_progress",
    )) {
      const action = a;
      list.push({
        id: `practice-${a.id}`,
        title: `Practice ${skillLabel(a.skillId)}`,
        hint: "Prepare",
        run: async () => {
          const r = await api.startInterview({
            mode: "practice",
            focusSkillId: action.skillId,
            actionId: action.id,
          });
          if (r.session) navigate(`/interview/${r.session.id}`);
        },
      });
    }
    for (const s of Object.values(graph)) {
      const id = s.skillId;
      list.push({
        id: `readiness-${id}`,
        title: `View ${s.label || id} readiness`,
        hint: "Readiness",
        run: () => navigate(`/readiness?skill=${encodeURIComponent(id)}`),
      });
    }
    for (const t of targets.filter((t) => !t.active)) {
      const target = t;
      list.push({
        id: `target-${t.id}`,
        title: `Switch target to ${t.role} — ${t.company}`,
        hint: "Target",
        run: async () => {
          await api.activateTarget(target.id);
          window.location.reload();
        },
      });
    }
    // v0.4: plugin-declared commands and interview modes
    for (const p of pluginUI) {
      for (const cmd of p.commands) {
        const action = cmd.action;
        list.push({
          id: `plugin-${p.pluginId}-${cmd.id}`,
          title: cmd.label,
          hint: p.pluginName,
          run: () => runUIAction(p.pluginId, action, { navigate }),
        });
      }
      for (const m of p.interviewModes) {
        const pluginModeId = `${p.pluginId}:${m.id}`;
        list.push({
          id: `plugin-mode-${pluginModeId}`,
          title: `Start ${m.label}`,
          hint: p.pluginName,
          run: async () => {
            const r = await api.startInterview({ pluginModeId });
            if (r.session) navigate(`/interview/${r.session.id}`);
          },
        });
      }
    }
    return list;
  }, [actions, graph, targets, pluginUI, navigate]);

  const filtered = useMemo(
    () => fuzzyFilter(commands, query, (c) => c.title),
    [commands, query],
  );

  const execute = useCallback(
    (cmd: Command | undefined) => {
      if (!cmd || busy) return;
      void api.recordEvent("palette.used").catch(() => {});
      setBusy(true);
      setError(null);
      Promise.resolve(cmd.run())
        .then(() => onClose())
        .catch((e) =>
          setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setBusy(false));
    },
    [busy, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(filtered[active]);
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus trap — the input keeps focus
    }
  };

  if (!open) return null;

  const activeDesc =
    filtered.length > 0 ? `cmd-${filtered[Math.min(active, filtered.length - 1)]?.id}` : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-navy/30 px-4 pt-24"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="w-full max-w-xl overflow-hidden rounded-[0.9rem] border border-line bg-surface shadow-xl"
      >
        <div className="border-b border-line px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            disabled={busy}
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeDesc}
            aria-autocomplete="list"
            placeholder="Type a command — interview modes, prep, targets…"
            className="w-full bg-transparent px-1 py-1.5 text-sm text-ink outline-none placeholder:text-muted disabled:opacity-60"
          />
        </div>
        {error && (
          <p role="alert" className="border-b border-line bg-[#fdeef2] px-4 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto pb-2"
        >
          {busy && (
            <div className="px-4 py-3 text-sm text-muted" role="status">
              Working…
            </div>
          )}
          {!busy && filtered.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted">
              No commands match “{query}”.
            </div>
          )}
          {!busy &&
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                id={`cmd-${cmd.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  execute(cmd);
                }}
                className={`mx-1 flex cursor-pointer items-center justify-between gap-3 rounded-[0.5rem] px-3 py-2 text-sm ${
                  i === active ? "bg-tint text-navy" : "text-ink"
                }`}
              >
                <span>{cmd.title}</span>
                {cmd.hint && (
                  <span className="shrink-0 text-xs text-muted">{cmd.hint}</span>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
