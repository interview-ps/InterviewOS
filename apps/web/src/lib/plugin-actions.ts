import { APP_ROUTE_ALLOWLIST, uiPathError } from "@interview-os/frontend-types";
import type { UIAction } from "@interview-os/frontend-types";
import { api } from "@/lib/api";
import { toast } from "@/components/ui";

export interface ActionCtx {
  navigate: (to: string) => void;
  /** re-render callback for runPlugin actions (host replaces the tree) */
  rerun?: (request: Record<string, unknown>) => void;
}

/**
 * Execute a plugin UI action on behalf of the host. Plugins never run app
 * code — every action maps to an existing app behavior, re-validated here.
 */
export function runUIAction(pluginId: string, action: UIAction, ctx: ActionCtx): void {
  switch (action.type) {
    case "navigate": {
      const to = action.to;
      const ok =
        uiPathError(to) === null &&
        ((APP_ROUTE_ALLOWLIST as readonly string[]).includes(to) ||
          to === `/plugins/${pluginId}` ||
          to.startsWith(`/plugins/${pluginId}/`));
      if (!ok) {
        toast("That destination isn't allowed");
        return;
      }
      ctx.navigate(to);
      return;
    }
    case "openPluginPage": {
      if (uiPathError(action.path) !== null) {
        toast("That destination isn't allowed");
        return;
      }
      ctx.navigate(`/plugins/${pluginId}${action.path}`);
      return;
    }
    case "startInterview": {
      void api
        .startInterview({
          roundType: action.roundType,
          plannedQuestions: action.plannedQuestions,
          pluginModeId: action.modeId ? `${pluginId}:${action.modeId}` : undefined,
        })
        .then((r) => {
          if (r.session) ctx.navigate(`/interview/${r.session.id}`);
        })
        .catch((e) => toast(e instanceof Error ? e.message : "Interview failed to start"));
      return;
    }
    case "startPractice": {
      void api
        .startInterview({ mode: "practice", focusSkillId: action.skillId })
        .then((r) => {
          if (r.session) ctx.navigate(`/interview/${r.session.id}`);
        })
        .catch((e) => toast(e instanceof Error ? e.message : "Practice failed to start"));
      return;
    }
    case "runPlugin": {
      ctx.rerun?.(action.request);
      return;
    }
  }
}
