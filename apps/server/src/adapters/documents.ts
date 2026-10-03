import { AppError } from "@interview-os/shared";

export type DocumentFormat = "pdf" | "docx" | "txt" | "md";

export interface ExtractResult {
  text: string;
  format: DocumentFormat;
  pages?: number;
  warnings: string[];
}

const MAX_CHARS = 50_000;

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

function isDocx(buf: Buffer): boolean {
  // zip magic + a word/document.xml entry (filename stored uncompressed in the zip)
  return (
    buf.length > 4 &&
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 &&
    buf.includes("word/document.xml")
  );
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract text from an uploaded document. pdf/docx are detected by magic
 * bytes, never by filename; the filename is only a hint for the txt/md label.
 */
export async function extractDocument(
  buf: Buffer,
  filenameHint = "",
): Promise<ExtractResult> {
  const warnings: string[] = [];
  let text = "";
  let format: DocumentFormat;
  let pages: number | undefined;

  if (isPdf(buf)) {
    format = "pdf";
    const { extractText } = await import("unpdf");
    try {
      const result = await extractText(new Uint8Array(buf), { mergePages: true });
      text = result.text;
      pages = result.totalPages;
    } catch {
      throw new AppError("EXTRACTION_FAILED", "Could not read this document");
    }
  } else if (isDocx(buf)) {
    format = "docx";
    const mammoth = await import("mammoth");
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value;
    } catch {
      throw new AppError("EXTRACTION_FAILED", "Could not read this document");
    }
  } else {
    // treat as plain text unless it looks binary
    const decoded = buf.toString("utf8");
    if (decoded.includes("\u0000")) {
      throw new AppError("UNSUPPORTED_FORMAT", "unsupported file format (not pdf/docx/text)");
    }
    format = filenameHint.toLowerCase().endsWith(".md") ? "md" : "txt";
    text = decoded;
  }

  text = normalize(text);
  if (text.length === 0) {
    warnings.push("No extractable text (scanned PDF?)");
  }
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    warnings.push(`Truncated to ${MAX_CHARS} characters`);
  }
  return { text, format, pages, warnings };
}
