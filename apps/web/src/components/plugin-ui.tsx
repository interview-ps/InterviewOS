import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { DeclarativeRenderer, ExtensionRegion, FRAME_MIN_HEIGHT } from "@interview-os/ui";
import type { UINode } from "@interview-os/frontend-types";
import {
  api,
  type PluginUIContributionView,
} from "@/lib/api";
import { runUIAction } from "@/lib/plugin-actions";
import { attachFrameBridge, frameSrc } from "@/lib/plugin-frame-bridge";
import { Skeleton } from "@/components/ui";

/* -- contributions cache ---------------------------------------------------- */

/** A declarative tree with no meaningful content — used to drop empty panels. */
function isEmptyUITree(node: UINode): boolean {
  const n = node as {
    type: string;
    children?: UINode[];
    items?: unknown[];
    tabs?: { children: UINode[] }[];
    text?: string;
  };
  switch (n.type) {
    case "text":
      return !(n.text ?? "").trim();
    case "divider":
      return true;
    case "list":
    case "evidenceList":
    case "progressList":
      return (n.items ?? []).length === 0;
    case "tabs":
      return (n.tabs ?? []).every(
        (t) => (t.children ?? []).length === 0 || (t.children ?? []).every(isEmptyUITree),
      );
    case "card":
    case "stack":
    case "row":
      return (
        (n.children ?? []).length === 0 || (n.children ?? []).every(isEmptyUITree)
      );
    default:
      return false;
  }
}

let contributionsCache: PluginUIContributionView[] | null = null;
let contributionsPromise: Promise<PluginUIContributionView[]> | null = null;

export function useUIContributions(): PluginUIContributionView[] {
  const [list, setList] = useState<PluginUIContributionView[]>(
    contributionsCache ?? [],
  );
  useEffect(() => {
    let cancelled = false;
    contributionsPromise ??= api
      .uiContributions()
      .then((r) => (contributionsCache = r.contributions))
      .catch(() => (contributionsCache = []));
    void contributionsPromise.then((v) => {
      if (!cancelled) setList(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

/** Force the next useUIContributions call to refetch (enable/disable changes). */
export function refreshUIContributions(): void {
  contributionsCache = null;
  contributionsPromise = null;
}

/* -- error boundary --------------------------------------------------------- */

class ContributionBoundary extends Component<
  { children: ReactNode; pluginId: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          data-testid="plugin-ui-error"
          className="rounded-[0.6rem] border border-line bg-page p-3 text-xs text-muted"
        >
          The “{this.props.pluginId}” plugin view failed to render.
        </div>
      );
    }
    return this.props.children;
  }
}

/* -- single contribution ---------------------------------------------------- */

function DeclarativeContribution({
  plugin,
  renderReq,
  attribution = true,
}: {
  plugin: PluginUIContributionView;
  renderReq: { slot?: string; component: string; page?: string; params?: unknown };
  attribution?: boolean;
}) {
  const navigate = useNavigate();
  const [tree, setTree] = useState<UINode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const paramsKey = JSON.stringify(renderReq.params ?? null);

  const load = useCallback(
    (params: unknown) => {
      setLoading(true);
      setError(null);
      api
        .renderPluginUI(plugin.pluginId, { ...renderReq, params })
        .then((r) => setTree(r.ui))
        .catch((e) =>
          setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setLoading(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugin.pluginId, renderReq.slot, renderReq.component, renderReq.page, paramsKey],
  );

  useEffect(() => {
    load(renderReq.params);
  }, [load]);

  const onAction = useCallback(
    (action: Parameters<typeof runUIAction>[1]) => {
      runUIAction(plugin.pluginId, action, {
        navigate,
        rerun: (request) => load({ action: request }),
      });
    },
    [plugin.pluginId, navigate, load],
  );

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (error) {
    return (
      <div
        role="alert"
        data-testid="plugin-ui-error"
        className="rounded-[0.6rem] border border-[color:var(--color-accent-tint)] bg-[var(--color-accent-tint)] p-3 text-xs text-[var(--color-accent)]"
      >
        Plugin view unavailable — {error}
      </div>
    );
  }
  if (!tree || isEmptyUITree(tree)) return null;
  return (
    <ContributionBoundary pluginId={plugin.pluginId}>
      <div>
        <DeclarativeRenderer node={tree} onAction={onAction} />
        {attribution && (
          <p className="mt-2 text-xs text-muted">from plugin {plugin.pluginName}</p>
        )}
      </div>
    </ContributionBoundary>
  );
}

/**
 * v0.4 Level 2: a plugin-authored component in an opaque-origin iframe.
 * `sandbox="allow-scripts"` only — never allow-same-origin/popups/top-
 * navigation/forms/modals — so the document cannot reach the app DOM,
 * cookies, storage, or the network; it can only talk through the bridge.
 */
export function PluginFrame({
  plugin,
  component,
  page,
  params,
  attribution = true,
}: {
  plugin: PluginUIContributionView;
  component?: string;
  page?: string;
  params?: Record<string, unknown>;
  attribution?: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const navigate = useNavigate();
  const [height, setHeight] = useState(FRAME_MIN_HEIGHT);
  const paramsKey = JSON.stringify(params ?? null);
  const src = frameSrc(plugin.pluginId, { component, page });

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    return attachFrameBridge({
      iframe,
      pluginId: plugin.pluginId,
      pluginName: plugin.pluginName,
      component,
      page,
      params,
      navigate,
      onResize: setHeight,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.pluginId, plugin.pluginName, component, page, paramsKey, navigate]);

  return (
    <ContributionBoundary pluginId={plugin.pluginId}>
      <div>
        <iframe
          ref={ref}
          data-testid="plugin-frame"
          sandbox="allow-scripts"
          src={src}
          title={`${plugin.pluginName} plugin view`}
          referrerPolicy="no-referrer"
          loading="lazy"
          style={{ height }}
          className="w-full rounded-[var(--radius-card)] border border-line bg-surface"
        />
        {attribution && (
          <p className="mt-2 text-xs text-muted">from plugin {plugin.pluginName}</p>
        )}
      </div>
    </ContributionBoundary>
  );
}

type SlotContribution = NonNullable<PluginUIContributionView["slots"][string]>[number];

function Contribution({
  plugin,
  contribution,
  slot,
  params,
}: {
  plugin: PluginUIContributionView;
  contribution: SlotContribution;
  slot: string;
  params?: Record<string, unknown>;
}) {
  if (contribution.kind === "frame") {
    return (
      <PluginFrame
        plugin={plugin}
        component={contribution.component}
        params={params}
      />
    );
  }
  return (
    <DeclarativeContribution
      plugin={plugin}
      renderReq={{ slot, component: contribution.component, params }}
    />
  );
}

/* -- slot host ---------------------------------------------------------------- */

/**
 * Render every enabled plugin's contributions for a slot. `params` are passed
 * to the plugin's render call (e.g. the skill being viewed).
 */
export function PluginSlot({
  slot,
  params,
}: {
  slot: string;
  params?: Record<string, unknown>;
}) {
  const contributions = useUIContributions();
  const list = useMemo(
    () =>
      contributions.flatMap((p) =>
        (p.slots[slot] ?? []).map((c) => ({ plugin: p, contribution: c })),
      ),
    [contributions, slot],
  );
  if (list.length === 0) return null;
  return (
    <>
      {list.map(({ plugin, contribution }) => (
        <Contribution
          key={`${plugin.pluginId}:${contribution.component}`}
          plugin={plugin}
          contribution={contribution}
          slot={slot}
          params={params}
        />
      ))}
    </>
  );
}

/**
 * A plugin slot wrapped in the shared compact, collapsed extension region.
 * Renders nothing when no enabled plugin contributes to the slot, so an empty
 * "Extensions" box never appears.
 */
export function ExtensionSlot({
  slot,
  title = "Extensions",
  hint = "plugins",
  params,
  defaultOpen = false,
  description,
}: {
  slot: string;
  title?: string;
  hint?: string;
  params?: Record<string, unknown>;
  defaultOpen?: boolean;
  description?: string;
}) {
  const contributions = useUIContributions();
  const has = contributions.some((p) => (p.slots[slot] ?? []).length > 0);
  if (!has) return null;
  return (
    <ExtensionRegion
      title={title}
      hint={hint}
      defaultOpen={defaultOpen}
      description={description}
      data-testid={`extension-${slot}`}
    >
      <PluginSlot slot={slot} params={params} />
    </ExtensionRegion>
  );
}

/**
 * True when the plugin that owns `modeId` contributes to `slot` — lets a host
 * decide synchronously whether to reserve an inspector column.
 */
export function useModeSlotHasContent(slot: string, modeId: string): boolean {
  const contributions = useUIContributions();
  return useMemo(
    () =>
      contributions.some(
        (p) => p.modes?.includes(modeId) && (p.slots[slot] ?? []).length > 0,
      ),
    [contributions, slot, modeId],
  );
}

/**
 * v1: like PluginSlot, but only renders contributions from the plugin that
 * owns the given interview mode (used by the `interview.question` slot so a
 * plugin mode can render a question panel such as the coding problem). The
 * wrapper carries the component name as data-testid — declarative trees
 * cannot set test ids themselves.
 */
export function PluginModeSlot({
  slot,
  modeId,
  params,
}: {
  slot: string;
  modeId: string;
  params?: Record<string, unknown>;
}) {
  const contributions = useUIContributions();
  const list = useMemo(
    () =>
      contributions
        .filter((p) => p.modes?.includes(modeId))
        .flatMap((p) =>
          (p.slots[slot] ?? []).map((c) => ({ plugin: p, contribution: c })),
        ),
    [contributions, slot, modeId],
  );
  if (list.length === 0) return null;
  return (
    <>
      {list.map(({ plugin, contribution }) => (
        <div key={`${plugin.pluginId}:${contribution.component}`} data-testid={contribution.component}>
          <Contribution
            plugin={plugin}
            contribution={contribution}
            slot={slot}
            params={params}
          />
        </div>
      ))}
    </>
  );
}
