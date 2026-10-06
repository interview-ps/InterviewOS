import { Link, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import {
  api,
  streamPost,
  type AvailableMode,
  type CompanyProfileInfo,
  type ExternalContext,
  type InterviewListItem,
  type InterviewLoop,
  type InterviewPackInfo,
  type McpServerInfo,
  type PrepAction,
  type RoundType,
  type StartInterviewResult,
  type StartLoopResult,
} from "@/lib/api";
import {
  Button,
  Card,
  CardTitle,
  displayLabel,
  EmptyState,
  ErrorNote,
  PageHeader,
  Pill,
  SectionHeading,
  SkeletonCard,
} from "@/components/ui";
import { useUIContributions } from "@/components/plugin-ui";
import { defaultModeId, defaultRoundModes } from "@/lib/modes";

interface LoopRoundDraft {
  mode: RoundType;
  label: string;
  plannedQuestions: number;
}

export default function Interview() {
  const navigate = useNavigate();
  const [modes, setModes] = useState<AvailableMode[]>([]);
  const [sessions, setSessions] = useState<InterviewListItem[] | null>(null);
  const [loops, setLoops] = useState<InterviewLoop[] | null>(null);
  const [profiles, setProfiles] = useState<CompanyProfileInfo[] | null>(null);
  const [quickAction, setQuickAction] = useState<PrepAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [roundType, setRoundType] = useState<RoundType>("technical");
  const [loopOpen, setLoopOpen] = useState(false);
  const [loopRounds, setLoopRounds] = useState<LoopRoundDraft[]>([]);
  const [contexts, setContexts] = useState<ExternalContext[]>([]);
  const [contextId, setContextId] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [fetchServer, setFetchServer] = useState("");
  const [fetchTool, setFetchTool] = useState("");
  const [fetchArgs, setFetchArgs] = useState("{}");
  const [fetchTitle, setFetchTitle] = useState("");
  const [fetching, setFetching] = useState(false);
  const [packs, setPacks] = useState<InterviewPackInfo[]>([]);
  const [packId, setPackId] = useState("");
  const pluginModes = useUIContributions().flatMap((p) =>
    p.interviewModes.map((m) => ({
      plugin: p.pluginName,
      pluginModeId: `${p.pluginId}:${m.id}`,
      ...m,
    })),
  );

  const modeLabel = (id: string) =>
    modes.find((m) => m.id === id)?.label ?? id.replace(/[-_]+/g, " ");

  const loadContexts = () =>
    api.mcpContexts().then(setContexts).catch(() => setContexts([]));

  // v1: keep the selected round type valid — prefer the historical default
  // ("technical") when its plugin is enabled, else the first available mode.
  useEffect(() => {
    if (modes.length === 0) return;
    setRoundType((cur) =>
      cur === "mixed" || modes.some((m) => m.id === cur) ? cur : defaultModeId(modes),
    );
  }, [modes]);

  useEffect(() => {
    api.modes().then((r) => setModes(r.modes)).catch(() => {});
    api.listInterviews().then(setSessions).catch((e) => setError(e));
    api.loops().then(setLoops).catch(() => setLoops([]));
    api.companies().then(setProfiles).catch(() => {});
    api
      .preparation()
      .then((p) =>
        setQuickAction(
          p.nextActions
            .filter((a) => a.status === "open" || a.status === "in_progress")
            .sort((a, b) => a.priority - b.priority)[0] ?? null,
        ),
      )
      .catch(() => {});
    loadContexts();
    api
      .mcpServers()
      .then((r) => {
        const enabled = r.servers.filter((s) => s.enabled);
        setMcpServers(enabled);
        if (enabled[0]) setFetchServer(enabled[0].id);
      })
      .catch(() => {});
    api.interviewPacks().then(setPacks).catch(() => {});
  }, []);

  const openLoopBuilder = async () => {
    setLoopOpen(true);
    if (loopRounds.length > 0) return;
    try {
      const targets = await api.listTargets();
      const active = targets.find((t) => t.active);
      const profile =
        profiles?.find((p) => p.id === (active?.companyProfileId ?? "generic")) ??
        profiles?.find((p) => p.id === "generic");
      // hide rounds whose mode isn't available (plugin disabled/absent)
      const available = new Set(modes.map((m) => m.id));
      const fallback = defaultRoundModes(modes).map((m) => ({
        mode: m.id,
        label: m.label,
      }));
      const rounds = (profile?.typicalLoop ?? fallback)
        .filter((s) => available.size === 0 || available.has(s.mode))
        .slice(0, 7)
        .map((s) => ({
          mode: s.mode as RoundType,
          label: s.label ?? modeLabel(s.mode),
          plannedQuestions: 3,
        }));
      setLoopRounds(
        rounds.length >= 2 ? rounds : fallback.map((r) => ({ ...r, plannedQuestions: 3 })),
      );
    } catch (e) {
      setError(e);
    }
  };

  const start = () => {
    setStarting(true);
    setStage(null);
    streamPost<StartInterviewResult>(
      "/api/interviews",
      { plannedQuestions: 4, roundType, ...(contextId ? { contextId } : {}) },
      { onStage: setStage },
    )
      .then((r) => r.session && navigate(`/interview/${r.session.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  const startQuick = () => {
    if (!quickAction) return;
    setStarting(true);
    setStage(null);
    api
      .startInterview({
        mode: "practice",
        focusSkillId: quickAction.skillId,
        actionId: quickAction.id,
      })
      .then((r) => r.session && navigate(`/interview/${r.session.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  const startLoop = () => {
    setStarting(true);
    setStage(null);
    streamPost<StartLoopResult>("/api/loops", { rounds: loopRounds }, { onStage: setStage })
      .then((r) => r.session && navigate(`/interview/${r.session.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  const moveRound = (i: number, dir: -1 | 1) => {
    setLoopRounds((rs) => {
      const next = [...rs];
      const j = i + dir;
      if (j < 0 || j >= next.length) return rs;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  const activeServer = mcpServers.find((s) => s.id === fetchServer);
  let argsError: string | null = null;
  let parsedArgs: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(fetchArgs || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      parsedArgs = v as Record<string, unknown>;
    } else {
      argsError = "Args must be a JSON object.";
    }
  } catch {
    argsError = "Args must be valid JSON.";
  }

  const fetchContext = () => {
    setFetching(true);
    setError(null);
    api
      .fetchMcpContext({
        serverId: fetchServer,
        tool: fetchTool,
        args: parsedArgs,
        ...(fetchTitle.trim() ? { title: fetchTitle.trim() } : {}),
      })
      .then(() => {
        setFetchTitle("");
        setFetchArgs("{}");
        return loadContexts();
      })
      .catch((e) => setError(e))
      .finally(() => setFetching(false));
  };

  const startPluginMode = (pluginModeId: string) => {
    setStarting(true);
    setStage(null);
    api
      .startInterview({ pluginModeId })
      .then((r) => r.session && navigate(`/interview/${r.session.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  const startPack = () => {
    setStarting(true);
    setStage(null);
    api
      .startInterviewPack(packId)
      .then((r) => navigate(`/interview/loop/${r.loop.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  const live = sessions?.filter((s) => s.status !== "debrief" && s.status !== "complete") ?? [];
  const past = sessions?.filter((s) => s.status === "debrief" || s.status === "complete") ?? [];
  const hasAdvanced =
    pluginModes.length > 0 || contexts.length > 0 || mcpServers.length > 0 || packs.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Interview"
        subtitle="Focused practice, a single mock round, or a full multi-round loop — every answer feeds your readiness."
      />

      {live.length > 0 && (
        <Card>
          <SectionHeading
            title={live.length > 1 ? "Interviews in progress" : "Continue your interview"}
            description="Pick up where you left off — finish this before starting another."
          />
          <ul className="space-y-3">
            {live.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="text-sm">
                  <div className="font-medium text-ink">
                    {s.mode === "practice"
                      ? "Practice session"
                      : `${s.modeLabel ?? displayLabel(s.roundType)} interview`}
                  </div>
                  <div className="text-muted">
                    round {s.currentRound}/{s.plannedQuestions} · started{" "}
                    {new Date(s.createdAt).toLocaleString()}
                    {s.loopId ? ` · loop round ${s.loopRound}` : ""}
                  </div>
                </div>
                <Link to={`/interview/${s.id}`}>
                  <Button>Resume interview</Button>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {live.length > 0 && <SectionHeading title="Or start another interview" />}

      <Card>
        <SectionHeading
          title="Focused practice"
          description="A short session on your highest-priority skill."
          action={
            <Button
              variant="secondary"
              onClick={startQuick}
              disabled={starting || !quickAction}
            >
              Start quick practice
            </Button>
          }
        />
        {quickAction ? (
          <p className="text-sm text-muted">{quickAction.action}</p>
        ) : (
          <p className="text-sm text-muted">
            No open preparation actions — pick a mode below instead.
          </p>
        )}
      </Card>

      <Card>
        <SectionHeading
          title="Mock interview"
          description="One round on a focus area. Pick a mode, then Start Interview."
        />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {modes.map((m) => (
            <label
              key={m.id}
              className={`cursor-pointer rounded-[0.6rem] border p-3 text-sm ${
                roundType === m.id ? "border-blue bg-page" : "border-line"
              }`}
            >
              <input
                type="radio"
                name="roundType"
                value={m.id}
                checked={roundType === m.id}
                onChange={() => setRoundType(m.id)}
                className="sr-only"
              />
              <span className="block font-medium text-ink">{m.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{m.description}</span>
              <span className="mt-1.5 block text-[0.7rem] text-muted">
                Scores: {m.rubric.map((r) => r.label).join(" · ")}
              </span>
            </label>
          ))}
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">More</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label
              className={`cursor-pointer rounded-[0.6rem] border p-3 text-sm ${
                roundType === "mixed" ? "border-blue bg-page" : "border-line"
              }`}
            >
              <input
                type="radio"
                name="roundType"
                value="mixed"
                checked={roundType === "mixed"}
                onChange={() => setRoundType("mixed")}
                className="sr-only"
              />
              <span className="block font-medium text-ink">Mixed (legacy)</span>
              <span className="mt-0.5 block text-xs text-muted">
                Weakness-driven mix of all areas — the v0.2 round.
              </span>
            </label>
          </div>
        </details>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={start} disabled={starting}>
            {starting ? "Preparing…" : "Start Interview"}
          </Button>
          <span className="text-sm text-muted">Uses the mode you selected above.</span>
        </div>
      </Card>

      <Card data-testid="loop-builder">
        <SectionHeading
          title="Full interview loop"
          description="Several rounds in sequence — weak skills carry forward and later rounds retest them, ending in a combined debrief."
          action={
            !loopOpen ? (
              <Button variant="secondary" onClick={openLoopBuilder} data-testid="open-loop-builder">
                Build a loop
              </Button>
            ) : undefined
          }
        />
        {loopOpen && (
          <div className="space-y-3">
            <ol className="space-y-2">
              {loopRounds.map((r, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-[0.5rem] border border-line p-2"
                >
                  <span className="w-5 text-center text-xs text-muted">{i + 1}</span>
                  <select
                    aria-label={`Round ${i + 1} mode`}
                    value={r.mode}
                    onChange={(e) =>
                      setLoopRounds((rs) =>
                        rs.map((x, j) =>
                          j === i ? { ...x, mode: e.target.value as RoundType } : x,
                        ),
                      )
                    }
                    className="rounded border border-line bg-white px-2 py-1 text-sm"
                  >
                    {modes.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Round ${i + 1} label`}
                    value={r.label}
                    onChange={(e) =>
                      setLoopRounds((rs) =>
                        rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                    className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-sm"
                    placeholder="Round label"
                  />
                  <label className="flex items-center gap-1 text-xs text-muted">
                    Q:
                    <input
                      type="number"
                      aria-label={`Round ${i + 1} questions`}
                      min={1}
                      max={6}
                      value={r.plannedQuestions}
                      onChange={(e) =>
                        setLoopRounds((rs) =>
                          rs.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  plannedQuestions: Math.max(
                                    1,
                                    Math.min(6, Number(e.target.value) || 1),
                                  ),
                                }
                              : x,
                          ),
                        )
                      }
                      className="w-14 rounded border border-line px-1 py-1 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Move round ${i + 1} up`}
                    onClick={() => moveRound(i, -1)}
                    className="text-muted hover:text-ink"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move round ${i + 1} down`}
                    onClick={() => moveRound(i, 1)}
                    className="text-muted hover:text-ink"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove round ${i + 1}`}
                    onClick={() => setLoopRounds((rs) => rs.filter((_, j) => j !== i))}
                    className="text-muted hover:text-ink"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                disabled={loopRounds.length >= 7}
                onClick={() => {
                  const id = defaultModeId(modes, "behavioral");
                  setLoopRounds((rs) => [
                    ...rs,
                    { mode: id, label: modeLabel(id), plannedQuestions: 3 },
                  ]);
                }}
              >
                + Add round
              </Button>
              <Button
                data-testid="start-loop"
                disabled={starting || loopRounds.length < 2}
                onClick={startLoop}
              >
                {starting ? "Starting…" : "Start loop"}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {hasAdvanced && (
        <Card>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-navy">
              Advanced options — plugin modes, external context, interview packs
            </summary>
            <div className="mt-4 space-y-5">
              {pluginModes.length > 0 && (
                <div data-testid="plugin-modes">
                  <CardTitle>Plugin modes</CardTitle>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {pluginModes.map((m) => (
                      <button
                        key={m.pluginModeId}
                        type="button"
                        onClick={() => startPluginMode(m.pluginModeId)}
                        disabled={starting}
                        className="rounded-[0.6rem] border border-divider p-3 text-left text-sm hover:bg-[var(--color-hover)] disabled:opacity-60"
                      >
                        <span className="block font-medium text-ink">{m.label}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {m.plugin} · {m.roundType.replace("_", " ")} · {m.plannedQuestions}{" "}
                          questions
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(contexts.length > 0 || mcpServers.length > 0) && (
                <div data-testid="external-context">
                  <CardTitle>External context</CardTitle>
                  <p className="mt-1 text-xs text-muted">
                    Attach one saved context — it is shown to the interviewer as untrusted
                    reference material.
                  </p>
                  {contexts.length > 0 && (
                    <ul className="mt-3 space-y-1.5 text-sm">
                      <li>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="context"
                            checked={contextId === ""}
                            onChange={() => setContextId("")}
                            className="accent-blue"
                          />
                          <span className="text-muted">No context</span>
                        </label>
                      </li>
                      {contexts.map((c) => (
                        <li key={c.id} className="flex items-center gap-2">
                          <label className="flex min-w-0 flex-1 items-center gap-2">
                            <input
                              type="radio"
                              name="context"
                              checked={contextId === c.id}
                              onChange={() => setContextId(c.id)}
                              className="accent-blue"
                            />
                            <span className="truncate">
                              {c.title}{" "}
                              <span className="text-xs text-muted">
                                ({c.text.length} chars · {c.serverId}/{c.tool})
                              </span>
                            </span>
                          </label>
                          <button
                            type="button"
                            aria-label={`Delete context ${c.title}`}
                            className="text-muted hover:text-danger"
                            onClick={() =>
                              api.deleteMcpContext(c.id).then(loadContexts).catch(setError)
                            }
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {mcpServers.length > 0 && (
                    <div className="mt-3 border-t border-line pt-3">
                      <p className="text-sm font-medium text-navy">Fetch context</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <select
                          aria-label="MCP server"
                          value={fetchServer}
                          onChange={(e) => {
                            setFetchServer(e.target.value);
                            setFetchTool("");
                          }}
                          data-testid="mcp-server-select"
                          className="rounded border border-line bg-white px-2 py-1.5 text-sm"
                        >
                          {mcpServers.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Tool"
                          value={fetchTool}
                          onChange={(e) => setFetchTool(e.target.value)}
                          data-testid="mcp-tool-select"
                          className="rounded border border-line bg-white px-2 py-1.5 text-sm"
                        >
                          <option value="">tool…</option>
                          {(activeServer?.allowedTools ?? []).map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <input
                          value={fetchTitle}
                          onChange={(e) => setFetchTitle(e.target.value)}
                          placeholder="Title (optional)"
                          aria-label="Context title"
                          className="min-w-0 flex-1 rounded border border-line px-2 py-1.5 text-sm"
                        />
                      </div>
                      <textarea
                        value={fetchArgs}
                        onChange={(e) => setFetchArgs(e.target.value)}
                        rows={2}
                        aria-label="Tool arguments (JSON)"
                        className="mt-2 w-full rounded-[0.6rem] border border-line px-3 py-2 font-mono text-xs"
                      />
                      {argsError && <p className="mt-1 text-xs text-danger">{argsError}</p>}
                      <Button
                        variant="secondary"
                        disabled={fetching || !fetchServer || !fetchTool || !!argsError}
                        onClick={fetchContext}
                        data-testid="fetch-context"
                      >
                        {fetching ? "Fetching…" : "Fetch context"}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {packs.length > 0 && (
                <div>
                  <CardTitle>Start from interview pack</CardTitle>
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      aria-label="Interview pack"
                      value={packId}
                      onChange={(e) => setPackId(e.target.value)}
                      data-testid="pack-select"
                      className="min-w-0 flex-1 rounded border border-line bg-white px-2 py-1.5 text-sm"
                    >
                      <option value="">choose a pack…</option>
                      {packs.map(({ pack }) => (
                        <option key={pack.id} value={pack.id}>
                          {pack.name} ({pack.rounds.length} rounds)
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="secondary"
                      disabled={starting || !packId}
                      onClick={startPack}
                      data-testid="start-pack"
                    >
                      Start pack
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </details>
        </Card>
      )}

      {starting && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          <span
            className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-blue align-middle"
            aria-hidden
          />
          {stage ? `${stage}…` : "Preparing…"}
        </p>
      )}
      <ErrorNote error={error} />
      {!sessions && !error && <SkeletonCard lines={2} />}

      {(loops ?? []).filter((l) => l.status !== "complete" || !l.abandoned).length > 0 && (
        <Card>
          <SectionHeading title="Loops" description="Multi-round interviews in progress." />
          <ul className="space-y-2 text-sm">
            {(loops ?? []).map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2">
                <Link to={`/interview/loop/${l.id}`} className="text-blue underline">
                  Loop {new Date(l.createdAt).toLocaleString()}
                </Link>
                <span className="flex items-center gap-2 text-muted">
                  {l.abandoned && <Pill tone="amber">abandoned</Pill>}
                  <Pill tone="blue">{l.status}</Pill>
                  round {l.currentRound}/{l.rounds.length}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {past.length > 0 && (
        <Card>
          <SectionHeading title="Past interviews" description="Review what happened." />
          <ul className="space-y-2 text-sm">
            {past.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <Link to={`/interview/${s.id}`} className="text-blue underline">
                  {new Date(s.createdAt).toLocaleString()}
                </Link>
                <span className="flex items-center gap-2 text-muted">
                  {s.mode === "practice" && <Pill tone="amber">Practice</Pill>}
                  {s.questions} questions
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {sessions?.length === 0 && (
        <Card>
          <EmptyState
            title="No interviews yet"
            description="Start one to begin practicing — every answer feeds the readiness model."
          />
        </Card>
      )}
    </div>
  );
}
