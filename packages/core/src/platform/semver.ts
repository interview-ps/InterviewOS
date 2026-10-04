export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const COMPARATOR_RE = /^(>=|<=|>|<)?\s*(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version: string): Semver | null {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isValidVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

function cmp(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function caretUpper(v: Semver): Semver {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0 };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: v.patch + 1 };
}

/**
 * Minimal semver range check: `*`, exact `x.y.z`, `>=`, `>`, `<=`, `<`,
 * `^x.y.z`, `~x.y.z`, and space-separated AND of comparators
 * (e.g. `>=0.4.0 <0.5.0`). Unknown tokens make the whole range unsatisfied.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") return true;
  for (const token of trimmed.split(/\s+/)) {
    if (token.startsWith("^")) {
      const base = parseVersion(token.slice(1));
      if (!base || cmp(v, base) < 0 || cmp(v, caretUpper(base)) >= 0) return false;
      continue;
    }
    if (token.startsWith("~")) {
      const base = parseVersion(token.slice(1));
      const upper: Semver | null = base
        ? { major: base.major, minor: base.minor + 1, patch: 0 }
        : null;
      if (!base || !upper || cmp(v, base) < 0 || cmp(v, upper) >= 0) return false;
      continue;
    }
    const m = COMPARATOR_RE.exec(token);
    if (!m) return false;
    const target: Semver = {
      major: Number(m[2]),
      minor: Number(m[3]),
      patch: Number(m[4]),
    };
    const c = cmp(v, target);
    switch (m[1] ?? "") {
      case ">=":
        if (c < 0) return false;
        break;
      case "<=":
        if (c > 0) return false;
        break;
      case ">":
        if (c <= 0) return false;
        break;
      case "<":
        if (c >= 0) return false;
        break;
      default:
        if (c !== 0) return false;
    }
  }
  return true;
}
