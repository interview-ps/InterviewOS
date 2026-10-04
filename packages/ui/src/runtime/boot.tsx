import { createRoot } from "react-dom/client";
import type { PluginFrameModule } from "../frame.js";
import { createPluginSDK } from "./sdk.js";
import { EmptyState } from "../components.js";

export interface BootOptions {
  /** URL of the plugin's built UI bundle (served from /api/plugins/:id/ui/assets/). */
  entry: string;
  /** render exp.components[component] when set */
  component?: string;
  /** render exp.pages[page] when set */
  page?: string;
}

/**
 * Load the plugin's UI module and render the requested component inside the
 * sandboxed document. Also wires auto-resize reporting to the host.
 */
export async function boot(opts: BootOptions): Promise<void> {
  const sdk = createPluginSDK();
  await sdk.ready();

  const mod = (await import(/* @vite-ignore */ opts.entry)) as {
    default?: PluginFrameModule;
  } & PluginFrameModule;
  const exp = mod.default ?? mod;
  const Comp = opts.component
    ? exp.components?.[opts.component]
    : exp.pages?.[opts.page ?? "/"];

  const el = document.getElementById("root") ?? document.body;
  const root = createRoot(el);
  root.render(
    Comp ? (
      <Comp sdk={sdk} />
    ) : (
      <EmptyState
        title="Missing frame component"
        description={`The plugin does not export ${opts.component ? `"${opts.component}"` : `a page for "${opts.page ?? "/"}"`}.`}
      />
    ),
  );

  let last = 0;
  const report = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== last) {
      last = h;
      sdk.resize(h);
    }
  };
  new ResizeObserver(report).observe(document.documentElement);
  report();
}
