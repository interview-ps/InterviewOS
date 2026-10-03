import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { InterviewOrchestrator, openStore } from "@interview-os/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";
import { createApp } from "../src/http/app.js";

function makeServer() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({ store, runtime, logger });
  return createApp({ orchestrator, runtime });
}

function minimalPdf(text: string): Buffer {
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

function minimalDocx(text: string): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

// PNG magic + a realistic IHDR chunk (contains NUL bytes like any real PNG)
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

async function upload(
  app: ReturnType<typeof makeServer>,
  buf: Buffer | string,
  name: string,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([buf], name));
  return app.request("/api/documents/extract", { method: "POST", body: form });
}

describe("POST /api/documents/extract (§8.2)", () => {
  it("extracts text from a PDF by magic bytes", async () => {
    const app = makeServer();
    const res = await upload(app, minimalPdf("Jordan Reyes senior backend engineer"), "resume.pdf");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe("pdf");
    expect(body.pages).toBe(1);
    expect(body.text).toContain("Jordan Reyes senior backend engineer");
  });

  it("extracts text from a DOCX", async () => {
    const app = makeServer();
    const res = await upload(
      app,
      minimalDocx("Experienced with Redis caching and Python"),
      "resume.docx",
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe("docx");
    expect(body.text).toContain("Experienced with Redis caching and Python");
  });

  it("extracts UTF-8 text files", async () => {
    const app = makeServer();
    const res = await upload(app, "line one\n\nline two   spaced", "notes.txt");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe("txt");
    expect(body.text).toBe("line one\n\nline two spaced");
  });

  it("treats a .pdf filename containing plain text as text", async () => {
    const app = makeServer();
    const res = await upload(app, "just plain text", "spoofed.pdf");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe("txt");
    expect(body.text).toBe("just plain text");
  });

  it("rejects unsupported formats with 415", async () => {
    const app = makeServer();
    const res = await upload(app, PNG, "image.png");
    expect(res.status).toBe(415);
    const body = await json(res);
    expect(body.error.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("returns 422 for a corrupt PDF that fails to parse", async () => {
    const app = makeServer();
    const res = await upload(
      app,
      Buffer.from("%PDF-1.4\n<not a real pdf>\x00\x01\x02 garbage"),
      "broken.pdf",
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe("EXTRACTION_FAILED");
  });

  it("rejects files over 5MB with 413", async () => {
    const app = makeServer();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    const res = await upload(app, big, "huge.txt");
    expect(res.status).toBe(413);
  });

  it("warns on empty extraction", async () => {
    const app = makeServer();
    const res = await upload(app, "   \n  \n", "empty.txt");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings[0]).toContain("No extractable text");
  });
});
