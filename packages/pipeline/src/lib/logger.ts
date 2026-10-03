import type { LogFields, Logger } from "../stages/types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "SERP_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "INDEXNOW_KEY",
  "TURNSTILE_SECRET",
  "GH_TOKEN",
] as const;

/** Secret values present in `env`, for redaction. Values under 6 characters are ignored. */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const k of SECRET_ENV_VARS) {
    const v = env[k];
    if (v && v.length >= 6) {
      out.push(v);
      // DataForSEO credentials are login:password; redact each part too.
      if (k === "SERP_API_KEY")
        for (const part of v.split(":")) if (part.length >= 6) out.push(part);
    }
  }
  return out;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

/**
 * A line logger for the CLI: `level msg {fields}` to stderr. Secret values from
 * the environment never reach the output (CLAUDE.md security rules).
 */
export function createLogger(
  opts: {
    level?: LogLevel;
    secrets?: readonly string[];
    sink?: (line: string) => void;
  } = {},
): Logger {
  const min = ORDER[opts.level ?? "info"];
  const secrets = opts.secrets ?? [];
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < min) return;
    const tail = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    sink(redact(`${level.padEnd(5)} ${msg}${tail}`, secrets));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** A logger that keeps lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (l) => lines.push(l) });
  return Object.assign(log, { lines });
}
