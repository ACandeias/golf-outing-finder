import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { COURSE_TYPE_SYSTEM_PROMPT } from "../courses/course-type-prompt.ts";
import { EXTRACT_MODEL, EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.ts";
import {
  batchResultSchema,
  type BatchClient,
  type BatchResult,
  type BatchState,
  type ExtractionRequest,
  type Logger,
} from "../stages/types.ts";

/**
 * The `claude-cli` LLM provider: the same BatchClient the Message Batches path
 * implements, backed by Claude Code headless (`claude -p`) on the owner's
 * subscription instead of API credits. Checked against `claude --help` of
 * Claude Code 2.1.289 on 2026-10-03:
 *
 * - `--output-format json` prints one result object: `{ type: "result",
 *   subtype, is_error, result, structured_output?, usage, total_cost_usd,
 *   duration_ms }`. `is_error` can be true with `subtype: "success"` (for
 *   example "Not logged in"), so both are checked.
 * - `--json-schema` makes the answer arrive in `structured_output`, validated by
 *   Claude Code; `result` then holds the same JSON as text. Without it the model
 *   tends to wrap JSON in a ```json fence, which `extractJsonText` also reads.
 * - `--bare` is NOT used: in bare mode Claude Code authenticates only with
 *   ANTHROPIC_API_KEY (OAuth and the keychain are never read), so it cannot use
 *   the subscription. `--safe-mode` (no CLAUDE.md, hooks, plugins, MCP servers
 *   or custom agents), `--strict-mcp-config`, an empty working directory and
 *   `--system-prompt` (our prompt replaces Claude Code's) stand in for it.
 * - Tools: `--tools ""` removes every built-in tool and `--disallowedTools`
 *   denies them again by name. Search mode allows WebSearch only.
 * - The child never sees ANTHROPIC_API_KEY or any other secret (`childEnv`), so
 *   it cannot fall back to API billing.
 *
 * One process per request, `concurrency` at a time (CLAUDE_CLI_CONCURRENCY,
 * default 3), 120 s timeout, two retries on transient failures. A batch "ends"
 * when every request has an answer, so the pending-batch logic is a no-op.
 * The budget guard is applied by `runExtractionBatch` before `submit`; the
 * reported usage feeds the run's token counters like a batch result would.
 * Never constructed in unit tests or dry runs: tests pass a fake spawner.
 */

export const CLAUDE_CLI_MODEL = EXTRACT_MODEL;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_CONCURRENCY = 3;
/** Retry backoff: 2 s, then 8 s. */
const BACKOFF_MS = [2_000, 8_000];
/** stdout cap per process; a result object is a few KB. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** Every Claude Code built-in tool, denied by name (belt and braces with `--tools ""`). */
export const DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TodoWrite",
  "Skill",
  "BashOutput",
  "KillShell",
  "ExitPlanMode",
];

/**
 * Set in every child. Claude Code turns on extended thinking for haiku by
 * default; measured on a fixture page that took 46 s and 5,536 output tokens,
 * against 7 s and 667 with thinking off. The Message Batches path sends no
 * thinking either.
 */
export const CHILD_ENV_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({ MAX_THINKING_TOKENS: "0" });

/** Environment variables a child process never receives. */
const SECRET_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|SERP_API_KEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|D1_DATABASE_ID|GH_TOKEN|GITHUB_TOKEN|INDEXNOW_KEY|TURNSTILE_SECRET)$/;

export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  return out;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all (e.g. `claude` not on PATH). */
  spawnError?: string;
}

/** Runs `claude` with `args`, writes `input` to stdin, kills it after `timeoutMs`. */
export type ClaudeSpawner = (
  args: readonly string[],
  input: string,
  opts: { timeoutMs: number },
) => Promise<SpawnResult>;

/** The real spawner. `bin` defaults to `claude` on PATH; runs in an empty directory. */
export function nodeClaudeSpawner(
  opts: { bin?: string; cwd?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): ClaudeSpawner {
  const cwd = opts.cwd ?? join(tmpdir(), "gof-claude-cli");
  mkdirSync(cwd, { recursive: true });
  const env = { ...childEnv(opts.env ?? process.env), ...CHILD_ENV_DEFAULTS };
  return (args, input, { timeoutMs }) =>
    new Promise<SpawnResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = spawn(opts.bin ?? "claude", [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const done = (r: SpawnResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killer);
        resolve(r);
      };
      let killer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        if (stdout.length < MAX_STDOUT_BYTES) stdout += d;
      });
      child.stderr.on("data", (d: string) => {
        if (stderr.length < 64_000) stderr += d;
      });
      child.on("error", (err) =>
        done({ exitCode: null, stdout, stderr, timedOut, spawnError: err.message }),
      );
      child.on("close", (code) => done({ exitCode: code, stdout, stderr, timedOut }));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
}

export interface ClaudeArgsSpec {
  model: string;
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  /** `none` for extraction and classification; `websearch` for the SERP provider. */
  tools: "none" | "websearch";
}

export function buildClaudeArgs(spec: ClaudeArgsSpec): string[] {
  const args = [
    "-p",
    "--model",
    spec.model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(spec.jsonSchema),
    "--system-prompt",
    spec.systemPrompt,
    "--no-session-persistence",
    "--safe-mode",
    "--strict-mcp-config",
  ];
  if (spec.tools === "websearch") {
    args.push(
      "--tools",
      "WebSearch",
      "--allowedTools",
      "WebSearch",
      "--disallowedTools",
      DISALLOWED_TOOLS.filter((t) => t !== "WebSearch").join(","),
    );
  } else {
    args.push("--tools", "", "--disallowedTools", DISALLOWED_TOOLS.join(","));
  }
  return args;
}

/** The result object of `claude -p --output-format json`. Extra keys pass through. */
export const claudeCliResultSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    api_error_status: z.number().nullable().optional(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().int().min(0),
        output_tokens: z.number().int().min(0),
        cache_read_input_tokens: z.number().int().min(0).optional(),
        cache_creation_input_tokens: z.number().int().min(0).optional(),
        server_tool_use: z
          .object({ web_search_requests: z.number().int().min(0).optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type ClaudeCliResult = z.infer<typeof claudeCliResultSchema>;

/** JSON from model text: the whole text, a ``` fence, or the outermost `{...}`. */
export function extractJsonText(text: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) {
    const v = tryParse(fence[1].trim());
    if (v !== undefined) return v;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return undefined;
}

/** Answers that mean "stop spawning": no login, or the subscription's usage limit. */
const FATAL = /not logged in|please run \/login|invalid api key|usage limit|limit reached|credit balance|oauth token (has )?expired/i;

export interface ClaudeUsage {
  /** Input tokens including cache reads and writes (what the request consumed). */
  input_tokens: number;
  output_tokens: number;
  web_search_requests: number;
}

export type ClaudeCallOutcome =
  | { ok: true; value: unknown; usage: ClaudeUsage; costUsd: number; durationMs: number; attempts: number }
  | {
      ok: false;
      kind: "fatal" | "transient";
      error: string;
      usage: ClaudeUsage;
      costUsd: number;
      attempts: number;
    };

export interface CallOptions {
  timeoutMs: number;
  retries: number;
  sleep: (ms: number) => Promise<void>;
  /** The zod check the answer must pass; a failing answer is retried like a transient error. */
  validate?: z.ZodTypeAny;
}

type Attempt =
  | { ok: true; value: unknown }
  | { ok: false; kind: "fatal" | "transient"; error: string };

function short(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** One request with retries. Never throws. */
export async function callClaude(
  spawner: ClaudeSpawner,
  spec: ClaudeArgsSpec & { input: string },
  opts: CallOptions,
): Promise<ClaudeCallOutcome> {
  const args = buildClaudeArgs(spec);
  const usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };
  let costUsd = 0;
  let durationMs = 0;
  let last: Attempt = { ok: false, kind: "transient", error: "not run" };
  const maxAttempts = 1 + Math.max(0, opts.retries);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await opts.sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)] ?? 8_000);
    const run = await spawner(args, spec.input, { timeoutMs: opts.timeoutMs });
    last = interpret(run, usage, opts.validate);
    const parsed = claudeCliResultSchema.safeParse(safeJson(run.stdout));
    if (parsed.success) {
      costUsd += parsed.data.total_cost_usd ?? 0;
      durationMs += parsed.data.duration_ms ?? 0;
    }
    if (last.ok) return { ok: true, value: last.value, usage, costUsd, durationMs, attempts: attempt };
    if (last.kind === "fatal") return { ...last, usage, costUsd, attempts: attempt };
  }
  return { ok: false, kind: "transient", error: last.ok ? "" : last.error, usage, costUsd, attempts: maxAttempts };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

function interpret(run: SpawnResult, usage: ClaudeUsage, validate: z.ZodTypeAny | undefined): Attempt {
  if (run.spawnError) return { ok: false, kind: "fatal", error: `could not start claude: ${short(run.spawnError)}` };
  if (run.timedOut) return { ok: false, kind: "transient", error: "timed out" };
  const parsed = claudeCliResultSchema.safeParse(safeJson(run.stdout));
  if (!parsed.success) {
    const text = `${run.stdout} ${run.stderr}`;
    if (FATAL.test(text)) return { ok: false, kind: "fatal", error: short(text) };
    return {
      ok: false,
      kind: "transient",
      error: `exit ${run.exitCode ?? "null"}: unreadable output${run.stderr ? ` (${short(run.stderr)})` : ""}`,
    };
  }
  const r = parsed.data;
  usage.input_tokens +=
    r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
  usage.output_tokens += r.usage.output_tokens;
  usage.web_search_requests += r.usage.server_tool_use?.web_search_requests ?? 0;
  if (r.is_error || r.subtype !== "success") {
    const msg = short(r.result ?? r.subtype);
    if (FATAL.test(msg)) return { ok: false, kind: "fatal", error: msg };
    return { ok: false, kind: "transient", error: `${r.subtype}: ${msg}` };
  }
  const value = r.structured_output !== undefined && r.structured_output !== null
    ? r.structured_output
    : extractJsonText(r.result ?? "");
  if (value === undefined) return { ok: false, kind: "transient", error: "no JSON in the answer" };
  if (validate) {
    const v = validate.safeParse(value);
    if (!v.success) {
      const issue = v.error.issues[0];
      return {
        ok: false,
        kind: "transient",
        error: `answer failed validation: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`,
      };
    }
    return { ok: true, value: v.data as unknown };
  }
  return { ok: true, value };
}

/** Maps `items` through `fn`, at most `concurrency` at a time, results in input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// The BatchClient
// ---------------------------------------------------------------------------

const textBlock = z.object({ type: z.string(), text: z.string() }).passthrough();
const requestParamsSchema = z
  .object({
    model: z.string().optional(),
    system: z.union([z.string(), z.array(textBlock)]),
    messages: z
      .array(z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(textBlock)]) }))
      .min(1),
    output_config: z.object({
      format: z.object({ type: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()) }),
    }),
  })
  .passthrough();

/**
 * Envelope checks per prompt, run on every answer before it leaves this edge.
 * Deliberately loose: extract-collect and the course-type collector apply the
 * strict per-event schemas (one bad event must not sink the whole page).
 */
const extractionEnvelope = z.object({ events: z.array(z.record(z.string(), z.unknown())).max(25) });
const courseTypeEnvelope = z.object({
  course_type: z.string(),
  confidence: z.number(),
  evidence: z.string(),
});

export function validatorFor(systemPrompt: string): z.ZodTypeAny {
  if (systemPrompt === EXTRACT_SYSTEM_PROMPT) return extractionEnvelope;
  if (systemPrompt === COURSE_TYPE_SYSTEM_PROMPT) return courseTypeEnvelope;
  return z.record(z.string(), z.unknown());
}

export interface ClaudeCliStats {
  requests: number;
  succeeded: number;
  errored: number;
  /** Processes started, retries included. */
  spawns: number;
  input_tokens: number;
  output_tokens: number;
  /** Sum of `total_cost_usd`: what the calls would cost at API list prices; the subscription covers it. */
  cost_usd: number;
  /** The fatal error that stopped the client, if any. */
  fatal: string | null;
  /** Requests not sent because actual input tokens reached the limit (`setInputTokenLimit`). */
  token_capped: number;
}

export interface ClaudeCliBatchOptions {
  spawner?: ClaudeSpawner;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

export class ClaudeCliBatchClient implements BatchClient {
  private readonly spawner: ClaudeSpawner;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger | undefined;
  private readonly batches = new Map<string, BatchResult[]>();
  private readonly totals: ClaudeCliStats = {
    requests: 0,
    succeeded: 0,
    errored: 0,
    spawns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    fatal: null,
    token_capped: 0,
  };
  private inputTokenLimit: number | null = null;
  private submitInputTokens = 0;

  constructor(o: ClaudeCliBatchOptions = {}) {
    this.spawner = o.spawner ?? nodeClaudeSpawner();
    this.concurrency = o.concurrency ?? DEFAULT_CONCURRENCY;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = o.retries ?? DEFAULT_RETRIES;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log;
  }

  stats(): ClaudeCliStats {
    return { ...this.totals };
  }

  /**
   * The input tokens the next `submit` may actually consume (what
   * MAX_LLM_INPUT_TOKENS_PER_RUN has left). The guard is charged the request
   * estimate up front; Claude Code adds its own overhead (the structured-output
   * tool carries the schema), so actual usage can exceed the estimate. Once
   * the actual total reaches the limit, the remaining requests are not sent and
   * come back errored, which leaves their pages queued for the next run.
   */
  setInputTokenLimit(limit: number | null): void {
    this.inputTokenLimit = limit;
  }

  async submit(requests: ExtractionRequest[]): Promise<BatchState> {
    const id = `claude_cli_${this.batches.size + 1}_${Date.now().toString(36)}`;
    this.submitInputTokens = 0;
    let done = 0;
    const results = await mapPool(requests, this.concurrency, async (r): Promise<BatchResult> => {
      const out = await this.one(r);
      done++;
      if (this.log && (done % 25 === 0 || done === requests.length))
        this.log.info("claude-cli progress", { done, of: requests.length, ...this.progressFields() });
      return out;
    });
    this.batches.set(id, results);
    return { batch_id: id, status: "ended" };
  }

  /** Every batch this client made has ended; an id it never made (an API batch) is reported ended too. */
  async poll(batchId: string): Promise<BatchState> {
    return { batch_id: batchId, status: "ended" };
  }

  async results(batchId: string): Promise<BatchResult[]> {
    return this.batches.get(batchId) ?? [];
  }

  private progressFields(): Record<string, number> {
    return {
      succeeded: this.totals.succeeded,
      errored: this.totals.errored,
      cost_usd_at_api_prices: Math.round(this.totals.cost_usd * 100) / 100,
    };
  }

  private errored(customId: string, type: string, message: string): BatchResult {
    this.totals.errored++;
    return { custom_id: customId, result: { type: "errored", error: { type, message } } };
  }

  private async one(r: ExtractionRequest): Promise<BatchResult> {
    this.totals.requests++;
    if (this.totals.fatal) return this.errored(r.custom_id, "claude_cli_stopped", this.totals.fatal);
    if (this.inputTokenLimit !== null && this.submitInputTokens >= this.inputTokenLimit) {
      this.totals.token_capped++;
      return this.errored(r.custom_id, "claude_cli_token_cap", "MAX_LLM_INPUT_TOKENS_PER_RUN reached (actual usage)");
    }
    const params = requestParamsSchema.safeParse(r.params);
    if (!params.success) return this.errored(r.custom_id, "claude_cli_bad_request", params.error.issues[0]?.message ?? "");
    const p = params.data;
    const systemPrompt = typeof p.system === "string" ? p.system : p.system.map((b) => b.text).join("\n\n");
    const first = p.messages[0];
    const input = !first ? "" : typeof first.content === "string" ? first.content : first.content.map((b) => b.text).join("\n\n");
    const outcome = await callClaude(
      this.spawner,
      {
        model: p.model ?? CLAUDE_CLI_MODEL,
        systemPrompt,
        jsonSchema: p.output_config.format.schema,
        tools: "none",
        input,
      },
      { timeoutMs: this.timeoutMs, retries: this.retries, sleep: this.sleep, validate: validatorFor(systemPrompt) },
    );
    this.totals.spawns += outcome.attempts;
    this.totals.input_tokens += outcome.usage.input_tokens;
    this.submitInputTokens += outcome.usage.input_tokens;
    this.totals.output_tokens += outcome.usage.output_tokens;
    this.totals.cost_usd += outcome.costUsd;
    if (!outcome.ok) {
      if (outcome.kind === "fatal" && !this.totals.fatal) {
        this.totals.fatal = outcome.error;
        this.log?.error("claude -p stopped; the remaining requests stay queued", { error: outcome.error });
      }
      return this.errored(r.custom_id, outcome.kind === "fatal" ? "claude_cli_fatal" : "claude_cli_error", outcome.error);
    }
    this.totals.succeeded++;
    const line: BatchResult = {
      custom_id: r.custom_id,
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "text", text: JSON.stringify(outcome.value) }],
          stop_reason: "end_turn",
          usage: { input_tokens: outcome.usage.input_tokens, output_tokens: outcome.usage.output_tokens },
        },
      },
    };
    const checked = batchResultSchema.safeParse(line);
    return checked.success ? checked.data : this.errored(r.custom_id, "invalid_result_line", "");
  }
}
