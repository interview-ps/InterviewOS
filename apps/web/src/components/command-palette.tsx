import { Modal } from "antd";
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
import { useAppRefresh } from "@/lib/app-refresh";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useAvailableModes } from "@/lib/modes";
import { skillLabel } from "@/components/ui";

interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => Promise<void> | void;
}

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
  const modes = useAvailableModes();
  const refresh = useAppRefresh();

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
    for (const m of modes) {
      const roundType = m.id as RoundType;
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
        title: "Extensions",
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
          navigate("/");
          refresh();
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
  }, [actions, graph, targets, pluginUI, modes, navigate, refresh]);

  const filtered = useMemo(
    () => fuzzyFilter(commands, query, (c) => c.title),
    [commands, query],
  );

  // Group by category (preserving first-seen order) so the category isn't
  // repeated on every row. `ordered` is the flat list keyboard nav indexes.
  const groups = useMemo(() => {
    const out: { label: string; items: Command[] }[] = [];
    const index = new Map<string, number>();
    for (const c of filtered) {
      const label = c.hint ?? "More";
      let i = index.get(label);
      if (i === undefined) {
        i = out.length;
        index.set(label, i);
        out.push({ label, items: [] });
      }
      out[i]!.items.push(c);
    }
    return out;
  }, [filtered]);

  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);

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
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, ordered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(ordered[active]);
    }
  };

  const activeDesc =
    ordered.length > 0
      ? `cmd-${ordered[Math.min(active, ordered.length - 1)]?.id}`
      : undefined;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      destroyOnHidden
      width="min(640px, calc(100vw - 24px))"
      style={{ top: 96 }}
      styles={{ body: { padding: 0 } }}
      focusable={{ focusTriggerAfterClose: true }}
      aria-label="Command palette"
    >
      <div data-testid="command-palette">
        <div className="border-b border-line px-3 py-2">
          <input
            ref={inputRef}
            autoFocus
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
          <p
            role="alert"
            className="border-b border-line bg-[#fdeef2] px-4 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto pb-1"
        >
          {busy && (
            <div className="px-4 py-3 text-sm text-muted" role="status">
              Working…
            </div>
          )}
          {!busy && ordered.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted">
              No commands match “{query}”. Try “practice”, “system design”, or a
              target name — or press Escape to close.
            </div>
          )}
          {!busy &&
            groups.map((g) => (
              <div key={g.label}>
                <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {g.label}
                </div>
                {g.items.map((cmd) => {
                  const i = ordered.indexOf(cmd);
                  return (
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
                      className={`mx-1 flex cursor-pointer items-center gap-3 rounded-[0.5rem] px-3 py-2 text-sm ring-1 ring-inset ${
                        i === active
                          ? "bg-tint font-medium text-navy ring-blue"
                          : "text-ink ring-transparent hover:bg-tint"
                      }`}
                    >
                      <span className="min-w-0 truncate">{cmd.title}</span>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-1.5 text-[11px] text-muted">
          <span>
            <kbd className="rounded border border-line px-1">↑</kbd>{" "}
            <kbd className="rounded border border-line px-1">↓</kbd> navigate
          </span>
          <span>
            <kbd className="rounded border border-line px-1">Enter</kbd> run
          </span>
          <span>
            <kbd className="rounded border border-line px-1">Esc</kbd> close
          </span>
        </div>
      </div>
    </Modal>
  );
}
