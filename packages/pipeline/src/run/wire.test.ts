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
import { createRunEdges, pendingNightlyBatch } from "./wire.ts";

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
