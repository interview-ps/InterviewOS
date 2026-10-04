import crypto from "node:crypto";

export interface FrameDoc {
  html: string;
  headers: Record<string, string>;
}

/**
 * The sandboxed iframe document for a plugin `kind: "frame"` contribution.
 * The only code it can load is the host runtime bundle and the plugin's own
 * assets — import-mapped through a per-response nonce, with `connect-src
 * 'none'` so no fetch/XHR/WebSocket can ever leave the iframe.
 */
export function buildFrameDocument(opts: {
  origin: string;
  pluginId: string;
  entry: string;
  component?: string;
  page?: string;
}): FrameDoc {
  const { origin, pluginId } = opts;
  const nonce = crypto.randomBytes(16).toString("base64");
  const runtimeJs = `${origin}/api/ui/runtime/plugin-runtime.js`;
  const runtimeCss = `${origin}/api/ui/runtime/plugin-runtime.css`;
  const assetsBase = `${origin}/api/plugins/${pluginId}/ui/assets/`;
  const entryUrl = `${assetsBase}${opts.entry.replace(/^ui\//, "")}`;

  const csp = [
    "default-src 'none'",
    `script-src ${assetsBase} ${runtimeJs} 'nonce-${nonce}'`,
    `style-src ${runtimeCss} 'nonce-${nonce}'`,
    "img-src data:",
    `font-src ${origin}/api/ui/runtime/`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");

  // only validated ids/paths reach this string; JSON.stringify keeps the
  // interpolation inside JS string literals regardless.
  const importMap = {
    imports: {
      "@interview-os/ui": runtimeJs,
      react: runtimeJs,
      "react/jsx-runtime": runtimeJs,
      "react-dom/client": runtimeJs,
    },
  };
  const bootArg = {
    entry: entryUrl,
    component: opts.component,
    page: opts.page,
  };

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${runtimeCss}" nonce="${nonce}">
<script type="importmap" nonce="${nonce}">${JSON.stringify(importMap)}</script>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}">
import { boot } from "@interview-os/ui";
boot(${JSON.stringify(bootArg)}).catch((err) => {
  document.getElementById("root").textContent =
    "Plugin view failed to start: " + String(err && err.message ? err.message : err);
});
</script>
</body>
</html>
`;

  return {
    html,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
    },
  };
}
