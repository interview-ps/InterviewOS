import type { APIRequestContext, Page } from "@playwright/test";

export const API = "http://127.0.0.1:4310";

/** Test-mode reset endpoint — only enabled when INTERVIEW_OS_TEST_MODE=1. */
export async function resetState(request: APIRequestContext) {
  const res = await request.post(`${API}/api/test/reset`);
  if (!res.ok()) throw new Error(`test reset failed: ${res.status()}`);
}

/** Set up the canonical backend-engineer workspace via the API (fast, no UI). */
export async function setupBackendExample(request: APIRequestContext) {
  const ex = await request.get(`${API}/api/examples/backend-engineer`);
  if (!ex.ok()) throw new Error(`example fetch failed: ${ex.status()}`);
  const body = await ex.json();
  const res = await request.post(`${API}/api/workspace/setup`, { data: body });
  if (!res.ok()) {
    throw new Error(`workspace setup failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

/** Fresh DB + canonical workspace — the standard per-test isolation hook. */
export async function freshWorkspace(request: APIRequestContext) {
  await resetState(request);
  return setupBackendExample(request);
}

/**
 * Answer every remaining question in a session (incl. follow-ups), then finish.
 * Probes the DOM via evaluate and sets values with the native setter + input
 * event so React picks them up — locator-based clicks proved flaky here
 * (locator.isVisible() could hang while evaluate stayed responsive), so this
 * stays as the robust driver for multi-question drain loops.
 */
export async function drainSession(page: Page, text: string, timeoutMs = 240_000) {
  const probe = () =>
    page.evaluate(() => {
      const btn = (label: string) =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === label,
        );
      const submit = btn("Submit Answer");
      const next = btn("Next Question");
      const finish = btn("Finish Interview");
      const postDone =
        !!document.querySelector('[data-testid="next-round"]') ||
        document.body.innerText.includes("View the loop debrief") ||
        document.body.innerText.includes("Debrief");
      return {
        submit: !!submit,
        nextEnabled: !!next && !next.disabled,
        finishEnabled: !!finish && !finish.disabled,
        postDone,
      };
    });
  const fillAndSubmit = (value: string) =>
    page.evaluate((v) => {
      const box = document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder*="answer" i], textarea[placeholder*="approach" i]',
      );
      const set = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      if (box) {
        set.call(box, v);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const submit = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Submit Answer",
      );
      submit?.click();
      return submit && !submit.disabled;
    }, value);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await probe();
    if (s.postDone) return;
    if (s.submit) {
      await fillAndSubmit(text);
      continue;
    }
    if (s.nextEnabled || s.finishEnabled) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find(
          (x) =>
            !x.disabled &&
            ["Next Question", "Finish Interview"].includes(
              x.textContent?.trim() ?? "",
            ),
        );
        b?.click();
      });
      continue;
    }
    await page.waitForTimeout(300);
  }
  throw new Error("drainSession: timed out draining session");
}

// minimal one-page PDF with a text object (proper xref so pdf.js parses it)
export function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
