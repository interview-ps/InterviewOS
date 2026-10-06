import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DeclarativeRenderer } from "@interview-os/ui";
import type { UINode } from "@interview-os/frontend-types";
import { api } from "@/lib/api";
import { runUIAction } from "@/lib/plugin-actions";
import { PluginFrame, useUIContributions } from "@/components/plugin-ui";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";

/** v0.4: full plugin pages at /plugins/<id>/<path> (manifest-declared). */
export default function PluginPage() {
  const { id, "*": rest } = useParams();
  const navigate = useNavigate();
  const contributions = useUIContributions();
  const plugin = contributions.find((p) => p.pluginId === id);
  const path = `/${rest ?? ""}`.replace(/\/+$/, "") || "/";
  const page = plugin?.pages.find((p) => p.path === path);

  const [tree, setTree] = useState<UINode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (params: unknown) => {
      if (!plugin || !page) return;
      setLoading(true);
      setError(null);
      api
        .renderPluginUI(plugin.pluginId, {
          page: page.path,
          component: page.component,
          params,
        })
        .then((r) => setTree(r.ui))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [plugin, page],
  );

  useEffect(() => {
    load(undefined);
  }, [load]);

  if (!plugin || !page) {
    return (
      <EmptyState
        title="Plugin page not found"
        description="This plugin doesn't declare a page at this path — or the plugin is disabled."
        action={
          <Link to="/skills">
            <Button variant="secondary">Back to Extensions</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div>
      <PageHeader
        title={page.title}
        subtitle={`from plugin ${plugin.pluginName}`}
      />
      <p className="mb-3 -mt-3 text-sm">
        <Link to="/skills" className="text-blue underline">
          ← Back to Extensions
        </Link>
      </p>
      {page.kind === "frame" ? (
        <PluginFrame
          plugin={plugin}
          component={page.component}
          page={page.path}
          attribution={false}
        />
      ) : loading ? (
        <Skeleton className="h-40 w-full" />
      ) : error ? (
        <div
          role="alert"
          data-testid="plugin-ui-error"
          className="rounded-[var(--radius-card)] border border-[color:var(--color-accent-tint)] bg-[var(--color-accent-tint)] p-3 text-sm text-[var(--color-accent)]"
        >
          Plugin page unavailable — {error}
        </div>
      ) : tree ? (
        <DeclarativeRenderer
          node={tree}
          onAction={(action) =>
            runUIAction(plugin.pluginId, action, {
              navigate,
              rerun: (request) => load({ action: request }),
            })
          }
        />
      ) : null}
    </div>
  );
}
