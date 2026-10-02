/**
 * Extract a string field from a *partially received* JSON buffer (§8.3 field
 * streaming). Matches `"field"` keys at depth 0 or 1 followed by a string
 * literal that may be unterminated. Escapes (\n \" \\ \uXXXX …) are decoded;
 * a dangling backslash or partial \u escape at the buffer end is dropped.
 * Returns null when the field's string hasn't started yet.
 */
export function extractPartialStringField(buf: string, field: string): string | null {
  const key = `"${field}"`;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      if (depth <= 1 && buf.startsWith(key, i)) {
        let j = i + key.length;
        while (j < buf.length && /\s/.test(buf.charAt(j))) j++;
        if (buf.charAt(j) === ":") {
          j++;
          while (j < buf.length && /\s/.test(buf.charAt(j))) j++;
          if (buf.charAt(j) === '"') return decodePartialString(buf, j + 1);
        }
      }
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return null;
}

function decodePartialString(buf: string, start: number): string {
  let out = "";
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '"') return out;
    if (ch === "\\") {
      const next = buf[i + 1];
      if (next === undefined) return out; // dangling backslash
      switch (next) {
        case "n": out += "\n"; i++; continue;
        case "t": out += "\t"; i++; continue;
        case "r": out += "\r"; i++; continue;
        case "b": out += "\b"; i++; continue;
        case "f": out += "\f"; i++; continue;
        case '"': out += '"'; i++; continue;
        case "\\": out += "\\"; i++; continue;
        case "/": out += "/"; i++; continue;
        case "u": {
          const hex = buf.slice(i + 2, i + 6);
          if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 5;
            continue;
          }
          return out; // partial \uXXXX at the buffer end — drop it
        }
        default: out += next; i++; continue;
      }
    }
    out += ch;
  }
  return out;
}
