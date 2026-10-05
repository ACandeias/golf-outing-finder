import { describe, expect, it } from "vitest";
import { migratedSqlite } from "@gof/db/testing";
import { resolveBudget } from "@gof/shared/budget";
import { anthropicBatchClient } from "../courses/course-types-ports.ts";
import { snapshotOver } from "../d1/sqlite.ts";
import { writeThrough } from "../d1/wrangler.ts";
import { sourceIdForUrl } from "../extract/ids.ts";
import type { FetchSidePorts } from "../fetch/ports.ts";
import { memoryLogger } from "../lib/logger.ts";
import { AnthropicBatchClient } from "../llm/batch-client.ts";
import { emptyOverrides } from "../overrides/load.ts";
import type { BatchClient, Context } from "../stages/types.ts";
import { llmFixtureIndex } from "./fixture-world.ts";
import { createRunEdges, pendingNightlyBatch, wiredHandlers } from "./wire.ts";
import { BudgetGuard } from "../budget.ts";
import { MemoryD1 } from "../d1/memory.ts";
import { EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.ts";
import { extractionOutputFormat } from "../extract/output-schema.ts";
import { ClaudeCliBatchClient, type ClaudeSpawner } from "../llm/claude-cli.ts";
import { emptyState } from "./state.ts";

const ctx: Context = {
  now: new Date("2026-09-28T12:00:00Z"),
  caps: resolveBudget("nightly"),
  overrides: emptyOverrides(),
  log: memoryLogger(),
  clock: { nowMs: () => 0 },
};

function runsDb(rows: [id: string, kind: string, started: string, pending: string | null, done: string[]][]) {
  const db = migratedSqlite();
  for (const [id, kind, started, pending, done] of rows) {
    db.prepare(
      "INSERT INTO runs (id, kind, started_at, pending_batch_id, stages_done) VALUES (?, ?, ?, ?, ?)",
    ).run(id, kind, started, pending, JSON.stringify(done));
  }
  return snapshotOver(db);
}

describe("pendingNightlyBatch", () => {
  it("reads the latest other nightly run that reached extract-collect, never monthly rows", () => {
    const snap = runsDb([
      ["run_a", "nightly", "2026-09-26T07:15:00Z", "msgbatch_old", ["extract-collect"]],
      ["run_b", "nightly", "2026-09-27T07:15:00Z", "msgbatch_b", ["discover", "extract-collect"]],
      ["run_m", "monthly", "2026-09-27T10:30:00Z", "msgbatch_monthly", ["courses"]],
      // Killed before extract-collect: it never decided, so run_b still speaks.
      ["run_c", "nightly", "2026-09-28T07:15:00Z", null, ["discover", "fetch"]],
      ["run_now", "nightly", "2026-09-28T12:00:00Z", null, []],
    ]);
    expect(pendingNightlyBatch(snap, "run_now")).toBe("msgbatch_b");
  });

  it("is null once a later run collected it, and with no runs at all", () => {
    const snap = runsDb([
      ["run_a", "nightly", "2026-09-26T07:15:00Z", "msgbatch_a", ["extract-collect"]],
      ["run_b", "nightly", "2026-09-27T07:15:00Z", null, ["extract-collect"]],
    ]);
    expect(pendingNightlyBatch(snap, "run_now")).toBeNull();
    expect(pendingNightlyBatch(runsDb([]), "run_now")).toBeNull();
  });
});

describe("writeThrough (WranglerD1's snapshot working copy)", () => {
  it("applies accepted statements to the snapshot so later stages read them", () => {
    const db = migratedSqlite();
    writeThrough(db, [
      "INSERT INTO submissions (id, url, note, created_at, processed) VALUES ('s1', 'https://a.example/', NULL, '2026-09-28T00:00:00Z', 0);",
      "UPDATE submissions SET processed = 1 WHERE id = 's1';",
    ]);
    expect(db.prepare("SELECT processed FROM submissions").get()).toEqual({ processed: 1 });
  });

  it("rolls the copy back whole when a statement fails", () => {
    const db = migratedSqlite();
    expect(() =>
      writeThrough(db, [
        "INSERT INTO submissions (id, url, note, created_at, processed) VALUES ('s1', 'https://a.example/', NULL, '2026-09-28T00:00:00Z', 0);",
        "INSERT INTO nope VALUES (1);",
      ]),
    ).toThrow(/local snapshot copy failed/);
    expect(db.prepare("SELECT count(*) AS n FROM submissions").get()).toEqual({ n: 0 });
  });
});

describe("run edges", () => {
  it("a live run shares one batch client between extraction and the monthly course types", () => {
    const shared: BatchClient = { submit: async () => ({ batch_id: "b", status: "ended" }), poll: async () => ({ batch_id: "b", status: "ended" }), results: async () => [] };
    const edges = createRunEdges({ ctx, mode: "live", env: {}, liveBatch: shared, indexnow: null });
    expect(edges.extractionBatch()).toBe(shared);
    expect(edges.ports().batch).toBe(shared);
    expect(edges.ports().fetcher).toBeDefined();
    // D's fallback factory builds the same client class C's extraction uses.
    expect(anthropicBatchClient({} as never)).toBeInstanceOf(AnthropicBatchClient);
  });

  it("a dry run hands D no live ports and replays the LLM fixtures", () => {
    const edges = createRunEdges({ ctx, mode: "dry-run", env: {} });
    expect(edges.ports()).toEqual({});
    expect(edges.indexnow()).toBeNull();
    expect(edges.extractionBatch()).not.toBeInstanceOf(AnthropicBatchClient);
  });

  it("closes the fetch side (renderer, HTTP validators) once, at the end of the run", async () => {
    let closed = 0;
    const side = { close: async () => void closed++ } as unknown as FetchSidePorts;
    const edges = createRunEdges({ ctx, mode: "dry-run", env: {}, fetchSide: side });
    expect(await edges.fetchSide()).toBe(side);
    await edges.close();
    expect(closed).toBe(1);
  });

  it("--llm=claude-cli: extraction and course types share one claude -p client; no Anthropic client, no API key", () => {
    const spawner: ClaudeSpawner = async () => {
      throw new Error("not spawned in this test");
    };
    const edges = createRunEdges({ ctx, mode: "live", env: {}, llm: "claude-cli", serp: "claude-search", claudeSpawner: spawner, indexnow: null });
    expect(edges.extractionBatch()).toBeInstanceOf(ClaudeCliBatchClient);
    expect(edges.ports().batch).toBe(edges.extractionBatch());
    expect(edges.claudeCli()).toBe(edges.extractionBatch());
    expect(edges.costNote(123)).toMatch(/^Estimated cost at API rates: \$1\.23, covered by subscription/);
    // API providers: no note, no claude-cli client.
    const api = createRunEdges({ ctx, mode: "live", env: {}, indexnow: null });
    expect(api.costNote(123)).toBeNull();
    expect(api.claudeCli()).toBeNull();
    // A dry run ignores the provider and replays fixtures.
    const dry = createRunEdges({ ctx, mode: "dry-run", env: {}, llm: "claude-cli", claudeSpawner: spawner });
    expect(dry.extractionBatch()).not.toBeInstanceOf(ClaudeCliBatchClient);
    expect(dry.llm).toBe("api");
  });

  it("extract-collect with claude-cli skips an API batch left pending and meters actual input tokens", async () => {
    const answer = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: { events: [] },
      usage: { input_tokens: 5000, output_tokens: 40 },
      total_cost_usd: 0.01,
    });
    let spawned = 0;
    const spawner: ClaudeSpawner = async () => {
      spawned++;
      return { exitCode: 0, stdout: answer, stderr: "", timedOut: false };
    };
    const edges = createRunEdges({ ctx, mode: "live", env: {}, llm: "claude-cli", claudeSpawner: spawner, indexnow: null });
    const snapshot = runsDb([["run_api", "nightly", "2026-09-27T07:15:00Z", "msgbatch_api", ["extract-collect"]]]);
    const guard = new BudgetGuard({ caps: resolveBudget("nightly"), now: ctx.now });
    const state = emptyState();
    const url = "https://example.org/outing";
    state.extractionRequests = [
      {
        custom_id: "src_a",
        page_url: url,
        est_input_tokens: 3000,
        params: {
          model: "claude-haiku-4-5",
          system: [{ type: "text", text: EXTRACT_SYSTEM_PROMPT }],
          messages: [{ role: "user", content: "<page>x</page>" }],
          output_config: { format: extractionOutputFormat() },
        },
      },
    ];
    state.extractionMeta = [
      { custom_id: "src_a", page_url: url, kind: "organizer", hash: "a".repeat(64), jsonld_events: [], directory_host: null },
    ];
    const handler = wiredHandlers(edges)["extract-collect"];
    const out = await handler({
      stage: "extract-collect",
      mode: "live",
      runId: "run_now",
      markProgress: async () => {},
      ctx,
      guard,
      state,
      snapshot,
      d1: new MemoryD1(),
      ports: {},
      irs: null,
    });
    expect(spawned).toBe(1);
    expect(out.pendingBatchId).toBeNull();
    expect(state.extracted).toHaveLength(1);
    // 3,000 estimated up front, 2,000 more once the actual 5,000 were known.
    expect(guard.spent("MAX_LLM_INPUT_TOKENS_PER_RUN")).toBe(5000);
    expect(guard.spent("MAX_EXTRACTIONS_PER_RUN")).toBe(1);
  });

  it("maps every recorded fixture page to its recording by custom_id (the source id)", () => {
    const { byCustomId, byUrl } = llmFixtureIndex();
    expect(byCustomId.get(sourceIdForUrl("https://azgolf.org/charity-club-sanctioned-events"))).toBe(
      "s01-encanto-pejatc",
    );
    expect(byUrl.get("https://fixtures.invalid/s15-synthetic-oakmont-glendale")).toBe(
      "s15-synthetic-oakmont-glendale",
    );
    expect(new Set(byUrl.values()).size).toBe(8);
  });
});
