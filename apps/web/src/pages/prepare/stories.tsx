import { useCallback, useEffect, useState } from "react";
import {
  api,
  streamPost,
  type StarStory,
  type StoryCoachResult,
} from "@/lib/api";
import { Button, Callout, Card, EmptyState, ErrorNote, Pill, ScreenToolbar, SkeletonCard, Spinner, skillLabel, Workspace } from "@/components/ui";
import { PrepareTabs } from "./tabs";

const STAR_FIELDS = ["situation", "task", "action", "result"] as const;
type StarField = (typeof STAR_FIELDS)[number];

interface CoachState {
  busy: boolean;
  feedback: string;
  result: StoryCoachResult | null;
}

export default function Stories() {
  const [stories, setStories] = useState<StarStory[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<StarField | "title", string>>>({});
  const [coach, setCoach] = useState<Record<string, CoachState>>({});
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.stories().then((rows) => {
      setStories(rows);
      setDrafts(
        Object.fromEntries(
          rows.map((s) => [
            s.id,
            { title: s.title, situation: s.situation, task: s.task, action: s.action, result: s.result },
          ]),
        ),
      );
    }).catch((e) => setError(e));
  }, []);

  useEffect(() => load(), [load]);

  const generate = () => {
    setGenerating(true);
    setStage(null);
    setError(null);
    streamPost<{ stories: StarStory[]; created: number }>("/api/stories/generate", {}, {
      onStage: setStage,
    })
      .then(load)
      .catch((e) => setError(e))
      .finally(() => { setGenerating(false); setStage(null); });
  };

  const save = (id: string) => {
    const d = drafts[id];
    if (!d) return;
    api.updateStory(id, d)
      .then(() => {
        setSaved((s) => ({ ...s, [id]: true }));
        setTimeout(() => setSaved((s) => ({ ...s, [id]: false })), 2000);
        load();
      })
      .catch((e) => setError(e));
  };

  const coachStory = (id: string) => {
    setCoach((c) => ({ ...c, [id]: { busy: true, feedback: "", result: null } }));
    streamPost<StoryCoachResult>(`/api/stories/${id}/coach`, {}, {
      onDelta: (field, text) => {
        if (field === "feedback") {
          setCoach((c) => ({ ...c, [id]: { ...c[id]!, feedback: text } }));
        }
      },
    })
      .then((r) => setCoach((c) => ({ ...c, [id]: { busy: false, feedback: r.feedback, result: r } })))
      .catch((e) => {
        setError(e);
        setCoach((c) => ({ ...c, [id]: { busy: false, feedback: "", result: null } }));
      });
  };

  const applyDraft = (id: string) => {
    const draft = coach[id]?.result?.improvedDraft;
    if (!draft) return;
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...draft } }));
  };

  return (
    <Workspace
      toolbar={
        <ScreenToolbar
          title="Prepare"
          subtitle="STAR stories"
          tabs={<PrepareTabs />}
          actions={
            <Button size="small" onClick={generate} disabled={generating}>
              {generating ? "Generating…" : "Generate from resume"}
            </Button>
          }
        />
      }
    >
      <div className="max-w-4xl space-y-3">
      {generating && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-blue align-middle" aria-hidden />
          {stage ? `${stage}…` : "Generating…"}
        </p>
      )}
      <ErrorNote error={error} />
      <Callout title="How to write a strong STAR story">
        Situation, Task, Action, Result. Replace every <code>[add …]</code> placeholder
        with a real detail — Interview OS never invents facts.
      </Callout>
      {!stories && !error && <SkeletonCard lines={4} />}
      {stories?.length === 0 && (
        <Card>
          <EmptyState
            title="No stories yet"
            description="Generate from your resume, or set up your workspace first — stories extracted during resume analysis appear here."
          />
        </Card>
      )}

      {stories?.map((s) => {
        const d = drafts[s.id];
        const c = coach[s.id];
        if (!d) return null;
        return (
          <Card key={s.id}>
            <div className="flex items-center justify-between gap-3">
              <input
                aria-label="Story title"
                value={d.title}
                onChange={(e) =>
                  setDrafts((p) => ({ ...p, [s.id]: { ...p[s.id]!, title: e.target.value } }))
                }
                className="w-full rounded-[var(--radius-sm)] border border-transparent px-2 py-1 text-base font-semibold text-navy hover:border-line focus:border-line focus:outline-none"
              />
              <Pill tone={s.source === "user" ? "green" : s.source === "generated" ? "blue" : "muted"}>
                {s.source}
              </Pill>
            </div>
            {s.skillIds.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {s.skillIds.map((id) => (
                  <Pill key={id} tone="muted">{skillLabel(id)}</Pill>
                ))}
              </p>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {STAR_FIELDS.map((f) => (
                <label key={f} className="block text-sm">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                    {f}
                  </span>
                  <textarea
                    value={d[f]}
                    onChange={(e) =>
                      setDrafts((p) => ({ ...p, [s.id]: { ...p[s.id]!, [f]: e.target.value } }))
                    }
                    rows={3}
                    className="w-full rounded-[var(--radius-md)] border border-line bg-surface p-2 text-sm"
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button variant="secondary" onClick={() => save(s.id)}>Save</Button>
              <Button variant="secondary" onClick={() => coachStory(s.id)} disabled={c?.busy}>
                {c?.busy ? "Coaching…" : "Coach me"}
              </Button>
              {saved[s.id] && <span className="text-xs text-green">Saved</span>}
            </div>
            {c && (c.busy || c.feedback) && (
              <div className="mt-3 rounded-[var(--radius-card)] bg-page p-3 text-sm" data-testid={`coach-${s.id}`} aria-live="polite">
                {c.busy && !c.feedback && <Spinner label="Coaching…" />}
                {c.feedback && (
                  <p className="text-muted">
                    {c.feedback}
                    {c.busy && <span aria-hidden>▌</span>}
                  </p>
                )}
                {c.result && (
                  <div className="mt-2 space-y-2">
                    {c.result.missing.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-accent">Missing / weak parts</p>
                        <ul className="list-disc pl-5 text-muted">
                          {c.result.missing.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    )}
                    {c.result.suggestions.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-navy">Suggestions</p>
                        <ul className="list-disc pl-5 text-muted">
                          {c.result.suggestions.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    )}
                    <Button variant="ghost" onClick={() => applyDraft(s.id)}>
                      Apply improved draft
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}
      </div>
    </Workspace>
  );
}
