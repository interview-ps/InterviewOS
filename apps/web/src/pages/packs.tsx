import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { allModes } from "@interview-os/core";
import {
  api,
  type CompanyPackView,
  type InterviewPackInfo,
  type InterviewPackInput,
  type PackListView,
  type RolePackView,
  type RoundType,
  type StartLoopResult,
  type TargetRole,
  type UserBankQuestion,
} from "@/lib/api";
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNote,
  PageHeader,
  Pill,
  SkeletonCard,
  Spinner,
  skillLabel,
  toast,
} from "@/components/ui";

const MODES = allModes();
const isHttps = (u: unknown): u is string =>
  typeof u === "string" && u.startsWith("https://");

const inputCls =
  "w-full rounded-[0.6rem] border border-line px-3 py-2 text-sm";

function InstallFromGit({
  kind,
  onInstalled,
}: {
  kind: "company" | "role";
  onInstalled: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-sm font-medium text-navy">Install from Git</p>
      <div className="mt-2 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… or a local path"
          aria-label={`${kind} pack URL or path`}
          className="min-w-0 flex-1 rounded-[0.6rem] border border-line px-3 py-2 text-sm"
        />
        <Button
          variant="secondary"
          disabled={busy || !url.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            api
              .installPack(kind, url.trim())
              .then(() => {
                setUrl("");
                onInstalled();
                toast("Pack installed");
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Installing…" : "Install"}
        </Button>
      </div>
      {error != null && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    </div>
  );
}

function ProvenancePill({ item }: { item: { provenance: string; source?: string } }) {
  return item.provenance === "sourced" ? (
    <Pill tone="green">Sourced{item.source ? `: ${item.source}` : ""}</Pill>
  ) : (
    <Pill tone="amber">Community (unverified)</Pill>
  );
}

function CompanyPackCard({
  pack,
  onChanged,
}: {
  pack: CompanyPackView;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sourceById = new Map(pack.sources.map((s) => [s.id, s]));

  const uninstall = () => {
    setBusy(true);
    api
      .uninstallPack("company", pack.id)
      .then(onChanged)
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <li className="rounded-[0.6rem] border border-line p-3" data-testid={`company-pack-${pack.id}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-navy">{pack.name}</span>
          <span className="text-xs text-muted">v{pack.version}</span>
          <Pill tone="muted">{pack.source}</Pill>
          <Pill tone="green">{pack.sourcedCount} sourced</Pill>
          <Pill tone="amber">{pack.communityCount} community</Pill>
          <span className="ml-auto text-muted" aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
        {pack.description && (
          <span className="mt-1 block text-sm text-muted">{pack.description}</span>
        )}
        <span className="mt-1 block text-xs text-muted">
          {pack.aliases.length > 0 && <>aliases: {pack.aliases.join(", ")} · </>}
          {pack.stages.length} stages
        </span>
      </button>
      {open && (
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <p className="text-xs text-muted">
            Provenance: <Pill tone="green">Sourced: title</Pill> items cite a
            declared source; <Pill tone="amber">Community (unverified)</Pill>{" "}
            items are community observations — treat them as unverified.
          </p>
          {pack.stages.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Stages:{" "}
              {pack.stages
                .map((s) => `${s.label || s.mode} (${s.plannedQuestions}q)`)
                .join(" → ")}
            </p>
          )}
          <ul className="mt-2 space-y-1.5">
            {pack.items.map((it, i) => {
              const src = it.source ? sourceById.get(it.source) : undefined;
              return (
                <li key={i} className="flex flex-wrap items-start gap-2">
                  <ProvenancePill item={it} />
                  <span className="min-w-0 flex-1">
                    <span className="text-xs text-muted">[{it.group}] </span>
                    {it.text}
                    {src && isHttps(src.url) && (
                      <a
                        href={src.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-xs text-blue underline"
                      >
                        {src.title}
                      </a>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      {pack.source === "installed" && (
        <div className="mt-2">
          {confirm ? (
            <span className="flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={uninstall}>
                Confirm uninstall
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Uninstall
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function RolePacks({
  packs,
  target,
  onChanged,
}: {
  packs: RolePackView[];
  target: TargetRole | null;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string>(target?.rolePackId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setSelected(target?.rolePackId ?? ""), [target?.rolePackId]);

  const apply = () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    api
      .setTargetRolePack(target.id, selected || null)
      .then(() => {
        toast("Role pack applied");
        onChanged();
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardTitle>Role packs</CardTitle>
      <p className="mt-1 text-xs text-muted">
        A role pack adds requirements and rubric dimensions to your active
        target{target ? ` (${target.role} — ${target.company})` : ""}.
      </p>
      {packs.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No role packs installed.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {packs.map((p) => (
            <li
              key={p.id}
              className={`rounded-[0.6rem] border p-3 ${
                target?.rolePackId === p.id ? "border-accent bg-tint" : "border-line"
              }`}
              data-testid={`role-pack-${p.id}`}
            >
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="role-pack"
                  value={p.id}
                  checked={selected === p.id}
                  onChange={() => setSelected(p.id)}
                  className="mt-1 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-navy">{p.name}</span>
                    <span className="text-xs text-muted">v{p.version}</span>
                    <Pill tone="muted">{p.source}</Pill>
                    {target?.rolePackId === p.id && (
                      <Pill tone="green">applied</Pill>
                    )}
                  </span>
                  {p.description && (
                    <span className="mt-0.5 block text-sm text-muted">
                      {p.description}
                    </span>
                  )}
                  <span className="mt-1 block text-xs text-muted">
                    {p.dimensions.length} dimensions · rounds:{" "}
                    {p.defaultQuestionCategories.join(", ")}
                  </span>
                </span>
              </label>
            </li>
          ))}
          <li className="rounded-[0.6rem] border border-line p-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="role-pack"
                value=""
                checked={selected === ""}
                onChange={() => setSelected("")}
                className="accent-accent"
              />
              <span className="text-sm text-muted">None — JD requirements only</span>
            </label>
          </li>
        </ul>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="mt-3">
        <Button
          variant="secondary"
          disabled={busy || !target || selected === (target.rolePackId ?? "")}
          onClick={apply}
          data-testid="apply-role-pack"
        >
          {busy ? "Applying…" : "Apply to active target"}
        </Button>
        {!target && (
          <span className="ml-2 text-xs text-muted">No active target.</span>
        )}
      </div>
      <InstallFromGit kind="role" onInstalled={onChanged} />
    </Card>
  );
}

interface RoundDraft {
  mode: RoundType;
  label: string;
  plannedQuestions: number;
}

function InterviewPackCreator({
  target,
  onCreated,
}: {
  target: TargetRole | null;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [duration, setDuration] = useState(120);
  const [skills, setSkills] = useState<string[]>([]);
  const [rounds, setRounds] = useState<RoundDraft[]>([
    { mode: "technical", label: "Technical", plannedQuestions: 3 },
    { mode: "behavioral", label: "Behavioral", plannedQuestions: 3 },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const requirements = target?.requirements ?? [];

  const create = () => {
    setBusy(true);
    setError(null);
    const body: InterviewPackInput = {
      name,
      description,
      author,
      skills,
      rounds,
      durationMinutes: duration,
    };
    api
      .createInterviewPack(body)
      .then(() => {
        toast("Interview pack created");
        onCreated();
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  const move = (i: number, dir: -1 | 1) =>
    setRounds((rs) => {
      const next = [...rs];
      const j = i + dir;
      if (j < 0 || j >= next.length) return rs;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const valid =
    name.trim().length > 0 &&
    skills.length >= 1 &&
    rounds.length >= 2 &&
    rounds.length <= 7;

  return (
    <div className="mt-3 rounded-[0.6rem] border border-line bg-page p-3" data-testid="pack-creator">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            data-testid="pack-name"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Author</span>
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block font-medium">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={inputCls}
        />
      </label>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium">
          Skills{requirements.length === 0 && " (no active target requirements)"}
        </legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {requirements.map((r) => (
            <label
              key={r.skillId}
              className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                skills.includes(r.skillId)
                  ? "border-accent bg-tint text-navy"
                  : "border-line text-muted"
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={skills.includes(r.skillId)}
                onChange={(e) =>
                  setSkills((s) =>
                    e.target.checked
                      ? [...s, r.skillId]
                      : s.filter((x) => x !== r.skillId),
                  )
                }
              />
              {r.label || skillLabel(r.skillId)}
            </label>
          ))}
        </div>
      </fieldset>
      <ol className="mt-3 space-y-2">
        {rounds.map((r, i) => (
          <li
            key={i}
            className="flex flex-wrap items-center gap-2 rounded-[0.5rem] border border-line p-2"
          >
            <span className="w-5 text-center text-xs text-muted">{i + 1}</span>
            <select
              aria-label={`Round ${i + 1} mode`}
              value={r.mode}
              onChange={(e) =>
                setRounds((rs) =>
                  rs.map((x, j) =>
                    j === i ? { ...x, mode: e.target.value as RoundType } : x,
                  ),
                )
              }
              className="rounded border border-line bg-white px-2 py-1 text-sm"
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <input
              aria-label={`Round ${i + 1} label`}
              value={r.label}
              onChange={(e) =>
                setRounds((rs) =>
                  rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                )
              }
              className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-sm"
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
                  setRounds((rs) =>
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
            <button type="button" aria-label={`Move round ${i + 1} up`} onClick={() => move(i, -1)} className="text-muted hover:text-ink">↑</button>
            <button type="button" aria-label={`Move round ${i + 1} down`} onClick={() => move(i, 1)} className="text-muted hover:text-ink">↓</button>
            <button
              type="button"
              aria-label={`Remove round ${i + 1}`}
              onClick={() => setRounds((rs) => rs.filter((_, j) => j !== i))}
              className="text-muted hover:text-ink"
            >
              ✕
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          disabled={rounds.length >= 7}
          onClick={() =>
            setRounds((rs) => [
              ...rs,
              { mode: "behavioral", label: "Behavioral", plannedQuestions: 3 },
            ])
          }
        >
          + Add round
        </Button>
        <label className="flex items-center gap-2 text-sm">
          Duration (minutes)
          <input
            type="number"
            min={15}
            max={600}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) || 15)}
            className="w-20 rounded border border-line px-2 py-1 text-sm"
          />
        </label>
        <Button
          disabled={busy || !valid}
          onClick={create}
          data-testid="create-pack"
        >
          {busy ? "Creating…" : "Create pack"}
        </Button>
      </div>
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    </div>
  );
}

function InterviewPacks({
  packs,
  target,
  onChanged,
}: {
  packs: InterviewPackInfo[];
  target: TargetRole | null;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const importPack = (content: string) => {
    if (!content.trim()) return;
    setBusy("import");
    setError(null);
    api
      .importInterviewPack(content)
      .then(() => {
        setImportText("");
        toast("Interview pack imported");
        onChanged();
      })
      .catch(setError)
      .finally(() => setBusy(null));
  };

  const start = (id: string) => {
    setBusy(id);
    setError(null);
    api
      .startInterviewPack(id)
      .then((r: StartLoopResult) => navigate(`/interview/loop/${r.loop.id}`))
      .catch(setError)
      .finally(() => setBusy(null));
  };

  return (
    <Card>
      <CardTitle>Interview packs</CardTitle>
      {packs.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No interview packs yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {packs.map(({ pack, source }) => (
            <li
              key={pack.id}
              className="rounded-[0.6rem] border border-line p-3"
              data-testid={`interview-pack-${pack.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-navy">{pack.name}</span>
                <span className="text-xs text-muted">v{pack.version}</span>
                <Pill tone={source === "bundled" ? "muted" : "blue"}>{source}</Pill>
                <span className="text-xs text-muted">
                  {pack.rounds.length} rounds · {pack.durationMinutes} min
                </span>
              </div>
              {pack.description && (
                <p className="mt-1 text-sm text-muted">{pack.description}</p>
              )}
              <p className="mt-1 text-xs text-muted">
                Skills: {pack.skills.map((s) => skillLabel(s)).join(", ")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={busy === pack.id}
                  onClick={() => start(pack.id)}
                  data-testid={`start-pack-${pack.id}`}
                >
                  {busy === pack.id ? "Starting…" : "Start"}
                </Button>
                <a
                  href={api.exportInterviewPackUrl(pack.id)}
                  className="inline-flex items-center rounded-[0.6rem] border border-line px-3 py-1.5 text-sm text-blue"
                  data-testid={`export-pack-${pack.id}`}
                >
                  Export
                </a>
                {source !== "bundled" &&
                  (confirmDelete === pack.id ? (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy === pack.id}
                        onClick={() => {
                          setBusy(pack.id);
                          api
                            .deleteInterviewPack(pack.id)
                            .then(() => {
                              setConfirmDelete(null);
                              onChanged();
                            })
                            .catch(setError)
                            .finally(() => setBusy(null));
                        }}
                      >
                        Confirm delete
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirmDelete(pack.id)}>
                      Delete
                    </Button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger" data-testid="pack-error">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="mt-4 border-t border-line pt-3">
        <Button
          variant="secondary"
          onClick={() => setCreating((v) => !v)}
          data-testid="toggle-create-pack"
        >
          {creating ? "Hide create form" : "Create an interview pack"}
        </Button>
        {creating && <InterviewPackCreator target={target} onCreated={() => { setCreating(false); onChanged(); }} />}
        <div className="mt-3">
          <p className="text-sm font-medium text-navy">Import a pack</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="file"
              accept=".yaml,.yml,.json"
              aria-label="Import pack file"
              data-testid="import-pack-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                f.text().then(importPack).catch(setError);
                e.target.value = "";
              }}
              className="text-xs text-muted"
            />
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={3}
            placeholder="…or paste pack YAML/JSON here"
            aria-label="Paste pack"
            className={`${inputCls} mt-2 font-mono text-xs`}
          />
          <div className="mt-2">
            <Button
              variant="secondary"
              disabled={busy === "import" || !importText.trim()}
              onClick={() => importPack(importText)}
            >
              {busy === "import" ? "Importing…" : "Import"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function QuestionBank({
  questions,
  target,
  onChanged,
}: {
  questions: UserBankQuestion[];
  target: TargetRole | null;
  onChanged: () => void;
}) {
  const [skillId, setSkillId] = useState("");
  const [text, setText] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [mode, setMode] = useState("");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requirements = target?.requirements ?? [];

  useEffect(() => {
    if (!skillId && requirements.length > 0) setSkillId(requirements[0]!.skillId);
  }, [requirements, skillId]);

  const add = () => {
    setBusy(true);
    setError(null);
    api
      .addBankQuestion({
        skillId,
        text,
        difficulty,
        ...(mode ? { mode: mode as RoundType } : {}),
      })
      .then(() => {
        setText("");
        toast("Question added");
        onChanged();
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardTitle>Question bank</CardTitle>
      <p className="mt-1 text-xs text-muted">
        Your own questions — interviewers draw from them when the skill matches.
      </p>
      {questions.length === 0 ? (
        <p className="mt-3 text-sm text-muted" data-testid="bank-empty">No questions yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {questions.map((q) => (
            <li
              key={q.source.id}
              className="flex items-start justify-between gap-2 rounded-[0.6rem] border border-line p-2 text-sm"
              data-testid={`bank-question-${q.source.id}`}
            >
              <span>
                <Pill tone="muted">{skillLabel(q.skillId)}</Pill>{" "}
                {q.difficulty && <Pill tone="blue">{q.difficulty}</Pill>}{" "}
                {q.mode && <Pill tone="muted">{q.mode}</Pill>}
                <span className="block mt-1">{q.text}</span>
              </span>
              <button
                type="button"
                aria-label={`Delete question ${q.source.id}`}
                className="text-muted hover:text-danger"
                onClick={() =>
                  api.deleteBankQuestion(q.source.id).then(onChanged).catch(setError)
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="mt-3 border-t border-line pt-3 space-y-2" data-testid="bank-add">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Question skill"
            value={skillId}
            onChange={(e) => setSkillId(e.target.value)}
            data-testid="bank-skill"
            className="rounded border border-line bg-white px-2 py-1.5 text-sm"
          >
            {requirements.length === 0 && <option value="">select a skill…</option>}
            {requirements.map((r) => (
              <option key={r.skillId} value={r.skillId}>
                {r.label || skillLabel(r.skillId)}
              </option>
            ))}
          </select>
          <select
            aria-label="Difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
            className="rounded border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="easy">easy</option>
            <option value="medium">medium</option>
            <option value="hard">hard</option>
          </select>
          <select
            aria-label="Mode (optional)"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="">any mode</option>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Question text…"
          aria-label="Question text"
          data-testid="bank-text"
          className={inputCls}
        />
        <Button
          variant="secondary"
          disabled={busy || !skillId || text.trim().length < 10}
          onClick={add}
          data-testid="bank-add-btn"
        >
          {busy ? "Adding…" : "Add question"}
        </Button>
        <div className="mt-2">
          <p className="text-sm font-medium text-navy">Import questions</p>
          <input
            type="file"
            accept=".yaml,.yml,.json"
            aria-label="Import questions file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              f.text()
                .then((c) => api.importQuestionBank(c))
                .then(() => { toast("Questions imported"); onChanged(); })
                .catch(setError)
                .finally(() => { setBusy(false); e.target.value = ""; });
            }}
            className="mt-1 text-xs text-muted"
          />
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={2}
            placeholder="…or paste YAML/JSON"
            aria-label="Paste questions"
            className={`${inputCls} mt-2 font-mono text-xs`}
          />
          <div className="mt-2">
          <Button
            variant="secondary"
            disabled={busy || !importText.trim()}
            onClick={() => {
              setBusy(true);
              api
                .importQuestionBank(importText)
                .then(() => {
                  setImportText("");
                  toast("Questions imported");
                  onChanged();
                })
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            Import
          </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

const TABS = [
  ["companies", "Company packs"],
  ["roles", "Role packs"],
  ["interviews", "Interview packs"],
  ["bank", "Question bank"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function Packs() {
  const [tab, setTab] = useState<Tab>("companies");
  const [packs, setPacks] = useState<PackListView | null>(null);
  const [interviewPacks, setInterviewPacks] = useState<InterviewPackInfo[] | null>(null);
  const [bank, setBank] = useState<UserBankQuestion[] | null>(null);
  const [target, setTarget] = useState<TargetRole | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.packs().then(setPacks).catch(setError);
    api.interviewPacks().then(setInterviewPacks).catch(() => setInterviewPacks([]));
    api.questionBank().then(setBank).catch(() => setBank([]));
    api
      .state()
      .then((s) => setTarget(s.target.id === "none" ? null : s.target))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (!packs && !error) {
    return (
      <div className="space-y-5">
        <PageHeader title="Packs" />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packs"
        subtitle="Installable content — company, role and interview packs, plus your own question bank."
      />
      <ErrorNote error={error} />
      <div className="flex gap-1 border-b border-line" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            data-testid={`tab-${id}`}
            className={`px-4 py-2 text-sm font-medium ${
              tab === id
                ? "border-b-2 border-accent text-navy"
                : "text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "companies" && packs && (
        <Card>
          <CardTitle>Company packs</CardTitle>
          {packs.companies.length === 0 ? (
            <EmptyState title="No company packs" description="Install one from Git below." />
          ) : (
            <ul className="mt-3 space-y-2">
              {packs.companies.map((p) => (
                <CompanyPackCard key={p.id} pack={p} onChanged={load} />
              ))}
            </ul>
          )}
          <InstallFromGit kind="company" onInstalled={load} />
        </Card>
      )}

      {tab === "roles" && packs && (
        <RolePacks packs={packs.roles} target={target} onChanged={load} />
      )}

      {tab === "interviews" && interviewPacks !== null && (
        <InterviewPacks packs={interviewPacks} target={target} onChanged={load} />
      )}
      {tab === "interviews" && interviewPacks === null && <Spinner />}

      {tab === "bank" && bank !== null && (
        <QuestionBank questions={bank} target={target} onChanged={load} />
      )}
      {tab === "bank" && bank === null && <Spinner />}

      {packs && packs.loadErrors.length > 0 && (
        <Card>
          <CardTitle>Pack load errors</CardTitle>
          <ul className="space-y-1 text-sm">
            {packs.loadErrors.map((e, i) => (
              <li key={i} className="text-danger">
                <span className="font-mono text-xs">{e.path}</span> — {e.error}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
