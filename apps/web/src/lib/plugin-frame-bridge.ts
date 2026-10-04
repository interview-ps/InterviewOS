import {
  clampFrameHeight,
  createFrameRateLimiter,
  parseFrameMessage,
  theme,
} from "@interview-os/ui";
import { UIActionSchema } from "@interview-os/core";
import { api } from "@/lib/api";
import { runUIAction } from "@/lib/plugin-actions";

/* -- bridge ------------------------------------------------------------------- */

export interface FrameBridgeOpts {
  iframe: HTMLIFrameElement;
  pluginId: string;
  pluginName: string;
  component?: string;
  page?: string;
  params?: Record<string, unknown>;
  navigate: (to: string) => void;
  onResize: (height: number) => void;
}

/**
 * Parent side of the plugin-frame protocol. Enforces: message source === the
 * iframe's contentWindow (an opaque-origin frame reports `event.origin` as
 * "null", which we require explicitly), envelope schema, 64 KB size cap and a
 * 20 msg/s rate limit. Replies are posted with targetOrigin "*" — required,
 * because the frame has no namable origin — and safe because they are
 * addressed to this iframe's window alone.
 */
export function attachFrameBridge(opts: FrameBridgeOpts): () => void {
  const allow = createFrameRateLimiter();
  const sel = { component: opts.component, page: opts.page };

  const reply = (id: string, type: "result" | "error", payload: unknown) => {
    opts.iframe.contentWindow?.postMessage({ v: 1, id, type, payload }, "*");
  };

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== opts.iframe.contentWindow) return;
    if (event.origin !== "null") return;
    const msg = parseFrameMessage(event.data);
    if (!msg || !allow()) return;
    try {
      switch (msg.type) {
        case "ready":
          reply(msg.id, "result", {
            pluginId: opts.pluginId,
            component: opts.component,
            page: opts.page,
            theme,
            params: opts.params,
          });
          return;
        case "getData": {
          const r = await api.pluginUIData(opts.pluginId, sel);
          reply(msg.id, "result", r.slices);
          return;
        }
        case "run": {
          const request = (msg.payload as { request?: Record<string, unknown> })
            ?.request;
          const r = await api.pluginUIRun(opts.pluginId, { ...sel, request });
          reply(msg.id, "result", r);
          return;
        }
        case "action": {
          const action = UIActionSchema.safeParse(
            (msg.payload as { action?: unknown })?.action,
          );
          if (!action.success) return;
          if (action.data.type === "runPlugin") {
            // inside a frame "re-render" = re-invoke the plugin statelessly
            const r = await api.pluginUIRun(opts.pluginId, {
              ...sel,
              request: { action: action.data.request },
            });
            reply(msg.id, "result", r);
            return;
          }
          runUIAction(opts.pluginId, action.data, { navigate: opts.navigate });
          reply(msg.id, "result", { ok: true });
          return;
        }
        case "resize":
          opts.onResize(
            clampFrameHeight((msg.payload as { height?: unknown })?.height),
          );
          return;
        default:
          return; // unknown types ignored
      }
    } catch (err) {
      reply(msg.id, "error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Frame document URL for a contribution (identifies plugin + component/page). */
export function frameSrc(
  pluginId: string,
  sel: { component?: string; page?: string },
): string {
  const q = new URLSearchParams();
  if (sel.component !== undefined) q.set("component", sel.component);
  if (sel.page !== undefined) q.set("page", sel.page);
  return `/api/plugins/${encodeURIComponent(pluginId)}/ui/frame?${q.toString()}`;
}
