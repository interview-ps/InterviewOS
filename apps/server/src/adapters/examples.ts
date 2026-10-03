import fs from "node:fs/promises";
import path from "node:path";

export interface ExampleEntry {
  name: string;
  resumeText: string;
  jobDescription: string;
  company: string;
  role: string;
  level: string;
  companyNotes?: string;
}

const NAME_PATTERN = /^[a-z0-9-]+$/;

export async function listExamples(examplesDir: string): Promise<string[]> {
  const entries = await fs.readdir(examplesDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Returns null when the example is unknown or unreadable (route maps it to 404). */
export async function readExample(
  examplesDir: string,
  name: string,
): Promise<ExampleEntry | null> {
  if (!NAME_PATTERN.test(name)) return null;
  try {
    const dir = path.join(examplesDir, name);
    const [resumeText, jobDescription, metaRaw, companyNotes] = await Promise.all([
      fs.readFile(path.join(dir, "resume.md"), "utf8"),
      fs.readFile(path.join(dir, "job.md"), "utf8"),
      fs.readFile(path.join(dir, "meta.json"), "utf8"),
      fs.readFile(path.join(dir, "company.md"), "utf8").catch(() => ""),
    ]);
    const meta = JSON.parse(metaRaw) as { company: string; role: string; level: string };
    return {
      name,
      resumeText,
      jobDescription,
      companyNotes: companyNotes || undefined,
      ...meta,
    };
  } catch {
    return null;
  }
}
