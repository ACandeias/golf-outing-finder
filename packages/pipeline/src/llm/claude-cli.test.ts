import { describe, expect, it } from "vitest";
import { EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.ts";
import { extractionOutputFormat } from "../extract/output-schema.ts";
import { batchResultSchema, type BudgetCheck, type ExtractionRequest } from "../stages/types.ts";
import { runExtractionBatch } from "./batch-client.ts";
import {
  buildClaudeArgs,
  callClaude,
  CHILD_ENV_DEFAULTS,
  childEnv,
  ClaudeCliBatchClient,
  DISALLOWED_TOOLS,
  extractJsonText,
  mapPool,
  type ClaudeSpawner,
  type SpawnResult,
} from "./claude-cli.ts";

/** A `claude -p --output-format json` result line, as observed from Claude Code 2.1.289. */
function cliResult(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"events":[]}',
    structured_output: { events: [] },
    usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.0021,
    duration_ms: 1400,
    num_turns: 2,
    ...over,
  });
}

function ok(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

interface Call {
  args: readonly string[];
  input: string;
  timeoutMs: number;
}

/** A spawner that answers from a queue (or a function) and records each call. Never runs a process. */
function fakeSpawner(answers: (SpawnResult | ((c: Call) => SpawnResult))[]): ClaudeSpawner & { calls: Call[] } {
  const calls: Call[] = [];
  const run: ClaudeSpawner = async (args, input, opts) => {
    const c = { args, input, timeoutMs: opts.timeoutMs };
    calls.push(c);
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (!next) throw new Error("no answer queued");
    return typeof next === "function" ? next(c) : next;
  };
  return Object.assign(run, { calls });
}

const noSleep = async (): Promise<void> => {};

function extractionRequest(id: string, page = "Golf outing on May 4 at Winged Foot."): ExtractionRequest {
  return {
    custom_id: id,
    page_url: `https://example.org/${id}`,
    est_input_tokens: 4000,
    params: {
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      temperature: 0,
      system: [{ type: "text", text: EXTRACT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `<page url="https://example.org/${id}">${page}</page>` }],
      output_config: { format: extractionOutputFormat() },
    },
  };
}

const allowAll: BudgetCheck = { check: () => true, monthlySpendOk: () => true };

describe("buildClaudeArgs", () => {
  it("runs headless on haiku with JSON output, the schema, our system prompt, no tools and no session", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } } };
    const args = buildClaudeArgs({ model: "claude-haiku-4-5", systemPrompt: "SYS", jsonSchema: schema, tools: "none" });
    expect(args.slice(0, 1)).toEqual(["-p"]);
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];
    expect(flag("--model")).toBe("claude-haiku-4-5");
    expect(flag("--output-format")).toBe("json");
    expect(JSON.parse(flag("--json-schema") ?? "null")).toEqual(schema);
    expect(flag("--system-prompt")).toBe("SYS");
    expect(flag("--tools")).toBe("");
    expect(flag("--disallowedTools")).toBe(DISALLOWED_TOOLS.join(","));
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    // --bare would switch auth to ANTHROPIC_API_KEY only (no subscription), so it is never passed.
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--allowedTools");
  });

  it("search mode allows WebSearch and nothing else", () => {
    const args = buildClaudeArgs({ model: "claude-haiku-4-5", systemPrompt: "S", jsonSchema: {}, tools: "websearch" });
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];
    expect(flag("--tools")).toBe("WebSearch");
    expect(flag("--allowedTools")).toBe("WebSearch");
    expect(flag("--disallowedTools")?.split(",")).not.toContain("WebSearch");
    expect(flag("--disallowedTools")?.split(",")).toContain("WebFetch");
    expect(flag("--disallowedTools")?.split(",")).toContain("Bash");
  });
});

describe("nodeClaudeSpawner settings", () => {
  it("turns extended thinking off in the child (the Batches path has none; with it on, haiku took 46 s and 5,500 output tokens per page)", () => {
    expect(CHILD_ENV_DEFAULTS).toEqual({ MAX_THINKING_TOKENS: "0" });
  });
});

describe("childEnv", () => {
  it("never hands an API key or another secret to the child, so it bills the subscription", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_AUTH_TOKEN: "tok",
      SERP_API_KEY: "a:b",
      CLOUDFLARE_API_TOKEN: "cf",
      GH_TOKEN: "gh",
      INDEXNOW_KEY: "ix",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
  });
});

describe("extractJsonText", () => {
  it("reads plain JSON, a ```json fence, or the first object in prose", () => {
    expect(extractJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonText('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJsonText('Here you go:\n```\n{"a":3}\n```\nDone.')).toEqual({ a: 3 });
    expect(extractJsonText('Sure. {"a":4} hope that helps')).toEqual({ a: 4 });
    expect(extractJsonText("no json here")).toBeUndefined();
  });
});

describe("callClaude", () => {
  const spec = { model: "claude-haiku-4-5", systemPrompt: "S", jsonSchema: {}, tools: "none" as const, input: "hi" };

  it("prefers structured_output and reports usage and cost", async () => {
    const spawn = fakeSpawner([ok(cliResult({ structured_output: { events: [{ title: "x" }] } }))]);
    const r = await callClaude(spawn, spec, { timeoutMs: 120_000, retries: 2, sleep: noSleep });
    expect(r).toMatchObject({
      ok: true,
      value: { events: [{ title: "x" }] },
      usage: { input_tokens: 1500, output_tokens: 90 },
      costUsd: 0.0021,
      attempts: 1,
    });
    expect(spawn.calls[0]?.input).toBe("hi");
    expect(spawn.calls[0]?.timeoutMs).toBe(120_000);
  });

  it("falls back to a fenced JSON block in `result` when there is no structured_output", async () => {
    const spawn = fakeSpawner([ok(cliResult({ structured_output: undefined, result: '```json\n{"events":[]}\n```' }))]);
    const r = await callClaude(spawn, spec, { timeoutMs: 1000, retries: 0, sleep: noSleep });
    expect(r).toMatchObject({ ok: true, value: { events: [] } });
  });

  it("retries a timeout, a non-zero exit and unparseable output, twice, then gives up", async () => {
    const spawn = fakeSpawner([
      { exitCode: null, stdout: "", stderr: "", timedOut: true },
      { exitCode: 1, stdout: "", stderr: "boom", timedOut: false },
      ok("not json"),
    ]);
    const r = await callClaude(spawn, spec, { timeoutMs: 1000, retries: 2, sleep: noSleep });
    expect(spawn.calls).toHaveLength(3);
    expect(r).toMatchObject({ ok: false, kind: "transient", attempts: 3 });
  });

  it("retries output that fails the zod validator and succeeds on the next try", async () => {
    const spawn = fakeSpawner([
      ok(cliResult({ structured_output: { nope: true } })),
      ok(cliResult({ structured_output: { events: [] } })),
    ]);
    const { z } = await import("zod");
    const r = await callClaude(spawn, spec, {
      timeoutMs: 1000,
      retries: 2,
      sleep: noSleep,
      validate: z.object({ events: z.array(z.unknown()) }),
    });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("stops at once when claude is not logged in or the subscription limit is reached", async () => {
    const notLogged = fakeSpawner([ok(cliResult({ is_error: true, result: "Not logged in · Please run /login" }))]);
    expect(await callClaude(notLogged, spec, { timeoutMs: 1000, retries: 2, sleep: noSleep })).toMatchObject({
      ok: false,
      kind: "fatal",
      attempts: 1,
    });
    const limit = fakeSpawner([ok(cliResult({ is_error: true, result: "Claude AI usage limit reached|1760000000" }))]);
    expect(await callClaude(limit, spec, { timeoutMs: 1000, retries: 2, sleep: noSleep })).toMatchObject({
      ok: false,
      kind: "fatal",
    });
  });
});

describe("mapPool", () => {
  it("never runs more than `concurrency` at once and keeps input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});

describe("ClaudeCliBatchClient", () => {
  it("is a BatchClient: one claude -p per request, results in the Message Batches shape", async () => {
    const spawn = fakeSpawner([
      (c) =>
        ok(
          cliResult({
            structured_output: { events: [{ title: c.input.includes("/a") ? "A" : "B" }] },
          }),
        ),
    ]);
    const client = new ClaudeCliBatchClient({ spawner: spawn, concurrency: 2, sleep: noSleep });
    const state = await client.submit([extractionRequest("a"), extractionRequest("b")]);
    expect(state.status).toBe("ended");
    expect(await client.poll(state.batch_id)).toEqual({ batch_id: state.batch_id, status: "ended" });
    const results = await client.results(state.batch_id);
    expect(results.map((r) => r.custom_id)).toEqual(["a", "b"]);
    for (const r of results) expect(batchResultSchema.safeParse(r).success).toBe(true);
    const first = results[0];
    if (first?.result.type !== "succeeded") throw new Error("expected success");
    expect(first.result.message.stop_reason).toBe("end_turn");
    expect(JSON.parse(first.result.message.content[0]?.text ?? "")).toEqual({ events: [{ title: "A" }] });
    expect(first.result.message.usage).toMatchObject({ input_tokens: 1500, output_tokens: 90 });

    // The system prompt and schema travel as flags, the page as stdin.
    const call = spawn.calls[0];
    expect(call?.args[call.args.indexOf("--system-prompt") + 1]).toBe(EXTRACT_SYSTEM_PROMPT);
    expect(JSON.parse(call?.args[call.args.indexOf("--json-schema") + 1] ?? "{}")).toEqual(
      extractionOutputFormat().schema,
    );
    expect(call?.input).toContain('<page url="https://example.org/a">');
    expect(client.stats()).toMatchObject({ requests: 2, succeeded: 2, errored: 0, input_tokens: 3000, output_tokens: 180 });
    expect(client.stats().cost_usd).toBeCloseTo(0.0042);
  });

  it("an extraction answer without an events array is retried and then errored, so the page stays queued", async () => {
    const spawn = fakeSpawner([ok(cliResult({ structured_output: { title: "no envelope" } }))]);
    const client = new ClaudeCliBatchClient({ spawner: spawn, sleep: noSleep });
    const { batch_id } = await client.submit([extractionRequest("a")]);
    const [r] = await client.results(batch_id);
    expect(spawn.calls).toHaveLength(3);
    expect(r?.result.type).toBe("errored");
  });

  it("after a fatal answer it spawns nothing more and errors the rest", async () => {
    const spawn = fakeSpawner([ok(cliResult({ is_error: true, result: "Not logged in · Please run /login" }))]);
    const client = new ClaudeCliBatchClient({ spawner: spawn, concurrency: 1, sleep: noSleep });
    const { batch_id } = await client.submit([extractionRequest("a"), extractionRequest("b"), extractionRequest("c")]);
    const results = await client.results(batch_id);
    expect(spawn.calls).toHaveLength(1);
    expect(results.map((r) => r.result.type)).toEqual(["errored", "errored", "errored"]);
    expect(client.stats().fatal).toMatch(/Not logged in/);
  });

  it("stops spawning once the actual input tokens reach the limit the guard left; the rest stay queued", async () => {
    // Each answer reports 1,500 input tokens (1,200 + 300 cache reads).
    const spawn = fakeSpawner([ok(cliResult())]);
    const client = new ClaudeCliBatchClient({ spawner: spawn, concurrency: 1, sleep: noSleep });
    client.setInputTokenLimit(2_000);
    const { batch_id } = await client.submit([extractionRequest("a"), extractionRequest("b"), extractionRequest("c")]);
    const results = await client.results(batch_id);
    expect(spawn.calls).toHaveLength(2);
    expect(results.map((r) => r.result.type)).toEqual(["succeeded", "succeeded", "errored"]);
    expect(client.stats()).toMatchObject({ token_capped: 1, input_tokens: 3000 });
  });

  it("an unknown batch id (an API batch from an earlier run) is ended with no results: pending logic is a no-op", async () => {
    const client = new ClaudeCliBatchClient({ spawner: fakeSpawner([ok(cliResult())]), sleep: noSleep });
    expect(await client.poll("msgbatch_from_the_api")).toEqual({ batch_id: "msgbatch_from_the_api", status: "ended" });
    expect(await client.results("msgbatch_from_the_api")).toEqual([]);
  });

  it("runExtractionBatch still applies MAX_EXTRACTIONS_PER_RUN and the token cap before anything is spawned", async () => {
    const spawn = fakeSpawner([ok(cliResult())]);
    const client = new ClaudeCliBatchClient({ spawner: spawn, sleep: noSleep });
    const refused: string[] = [];
    const budget: BudgetCheck = {
      check: (cap) => {
        refused.push(cap);
        return cap !== "MAX_LLM_INPUT_TOKENS_PER_RUN";
      },
      monthlySpendOk: () => true,
    };
    const out = await runExtractionBatch(client, [extractionRequest("a")], {
      pendingBatchId: null,
      budget,
      sleep: noSleep,
      nowMs: () => 0,
    });
    expect(out).toMatchObject({ status: "ended", submitted: 0, results: [] });
    expect(refused).toEqual(["MAX_EXTRACTIONS_PER_RUN", "MAX_LLM_INPUT_TOKENS_PER_RUN"]);
    expect(spawn.calls).toHaveLength(0);

    const ran = await runExtractionBatch(client, [extractionRequest("a")], {
      pendingBatchId: null,
      budget: allowAll,
      sleep: noSleep,
      nowMs: () => 0,
    });
    expect(ran).toMatchObject({ status: "ended", submitted: 1 });
    expect(ran.results).toHaveLength(1);
  });
});
