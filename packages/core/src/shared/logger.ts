export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /token|key|secret|password|authorization|cookie/i;
const REDACTED = "[REDACTED]";

function redactValue(value: unknown, keyHint: string | undefined, seen: WeakSet<object>): unknown {
  if (keyHint !== undefined && SENSITIVE_KEY.test(keyHint)) {
    return REDACTED;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((item) => redactValue(item, undefined, seen));
    seen.delete(value);
    return out;
  }
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redactValue(v, k, seen);
  }
  seen.delete(value);
  return out;
}

export function redact<T>(value: T): T {
  return redactValue(value, undefined, new WeakSet()) as T;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  [field: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function defaultSink(line: string): void {
  process.stdout.write(line + "\n");
}

export function createLogger(base?: LoggerOptions): Logger {
  const { level, sink, ...baseFields } = base ?? {};
  const minLevel: LogLevel = level ?? "info";
  const write = sink ?? defaultSink;
  const fieldsBase = redact(baseFields) as Record<string, unknown>;

  const emit = (lvl: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...fieldsBase,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(line));
  };

  return {
    level: minLevel,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) =>
      createLogger({ level: minLevel, sink: write, ...fieldsBase, ...fields }),
  };
}

/** Metadata-only view of untrusted text (resume/JD/answer): never log the text itself. */
export function textMeta(text: string): { length: number } {
  return { length: text.length };
}
