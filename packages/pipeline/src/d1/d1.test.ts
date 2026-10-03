import { describe, expect, it } from "vitest";
import { z } from "zod";
import { migratedSqlite } from "@gof/db/testing";
import { runRowSchema, type RunRow, type SourceOutingRow } from "../stages/rows.ts";
import type { UpsertPlan } from "../stages/types.ts";
import { MemoryD1 } from "./memory.ts";
import { planToFileChunks, planToStatements } from "./plan-sql.ts";
import { loadDump, openSqlite, snapshotOver } from "./sqlite.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyLocalD1, executeArgs, exportArgs, localD1File, parseQueryOutput, queryArgs } from "./wrangler.ts";

const run: RunRow = {
  id: "run_01",
  kind: "nightly",
  started_at: "2026-09-28T12:00:00.000Z",
  finished_at: null,
  stages_done: "[]",
  serp_queries: 0,
  fetches: 0,
  renders: 0,
  extractions: 0,
  course_classifications: 0,
  llm_input_tokens: 0,
  llm_output_tokens: 0,
  pending_batch_id: null,
  outings_new: 0,
  outings_updated: 0,
  outings_held: 0,
  budget_hits: "[]",
  errors: '[{"stage":"fetch","kind":"network","message":"it\'s down"}]',
  est_cost_cents: 0,
};

function links(n: number): SourceOutingRow[] {
  return Array.from({ length: n }, (_, i) => ({ source_id: `src_${i}`, outing_id: `out_${i}` }));
}

describe("planToStatements", () => {
  it("renders an upsert keyed on the primary key with literal values", () => {
    const [stmt, ...rest] = planToStatements({
      ops: [{ op: "upsert", table: "runs", rows: [run] }],
    });
    expect(rest).toEqual([]);
    expect(stmt).toMatch(
      /^INSERT INTO runs \(id, kind, started_at, .*\) VALUES \('run_01', 'nightly', /,
    );
    expect(stmt).toContain('\'[{"stage":"fetch","kind":"network","message":"it\'\'s down"}]\'');
    expect(stmt).toMatch(
      /ON CONFLICT\(id\) DO UPDATE SET kind = excluded\.kind, .*est_cost_cents = excluded\.est_cost_cents;$/,
    );
    expect(stmt).not.toMatch(/\?/);
  });

  it("supports DO NOTHING and an explicit update list", () => {
    const [a] = planToStatements({
      ops: [{ op: "upsert", table: "source_outings", rows: links(1) }],
    });
    expect(a).toMatch(/ON CONFLICT\(source_id, outing_id\) DO NOTHING;$/);
    const [b] = planToStatements({
      ops: [{ op: "upsert", table: "runs", rows: [run], update: ["stages_done", "fetches"] }],
    });
    expect(b).toMatch(
      /DO UPDATE SET stages_done = excluded\.stages_done, fetches = excluded\.fetches;$/,
    );
  });

  it("chunks at 50 rows per statement and 1,000 statements per file", () => {
    expect(
      planToStatements({ ops: [{ op: "upsert", table: "source_outings", rows: links(120) }] }),
    ).toHaveLength(3);
    const many: UpsertPlan = {
      ops: Array.from({ length: 2_100 }, (_, i) => ({
        op: "delete" as const,
        table: "source_outings" as const,
        where: { source_id: `src_${i}` },
      })),
    };
    expect(planToFileChunks(many).map((f) => f.length)).toEqual([1000, 1000, 100]);
  });

  it("renders UPDATE and DELETE with IS NULL for null keys", () => {
    expect(
      planToStatements({
        ops: [
          {
            op: "update",
            table: "outings",
            set: { published: 0, hold_reason: "removed" },
            where: { id: "out_1" },
          },
          {
            op: "delete",
            table: "sources",
            where: { hold_reason: null, url: "https://x.example/?a=1" },
          },
        ],
      }),
    ).toEqual([
      "UPDATE outings SET published = 0, hold_reason = 'removed' WHERE id = 'out_1';",
      "DELETE FROM sources WHERE hold_reason IS NULL AND url = 'https://x.example/?a=1';",
    ]);
  });

  it("validates the plan before writing any SQL", () => {
    expect(() =>
      planToStatements({
        ops: [{ op: "upsert", table: "runs", rows: [{ ...run, kind: "weekly" as "nightly" }] }],
      }),
    ).toThrow();
  });
});

describe("MemoryD1", () => {
  it("applies plans and reads them back through a validated snapshot", async () => {
    const d1 = new MemoryD1();
    await d1.apply({ ops: [{ op: "upsert", table: "runs", rows: [run] }] });
    await d1.apply({
      ops: [
        {
          op: "upsert",
          table: "runs",
          rows: [{ ...run, fetches: 12, stages_done: '["discover"]' }],
        },
      ],
    });
    await d1.apply({
      ops: [
        {
          op: "update",
          table: "runs",
          set: { pending_batch_id: "msgbatch_01" },
          where: { id: "run_01" },
        },
      ],
    });
    const snap = await d1.snapshot();
    const rows = snap.all("SELECT * FROM runs", runRowSchema);
    expect(rows).toEqual([
      { ...run, fetches: 12, stages_done: '["discover"]', pending_batch_id: "msgbatch_01" },
    ]);
    expect(d1.applied).toHaveLength(3);
  });

  it("rejects rows the snapshot schema does not accept", async () => {
    const d1 = new MemoryD1();
    await d1.apply({ ops: [{ op: "upsert", table: "runs", rows: [run] }] });
    const snap = await d1.snapshot();
    expect(() => snap.all("SELECT id, kind FROM runs", z.object({ id: z.number() }))).toThrow(
      /snapshot row 0/,
    );
  });

  it("keeps a URL with ? in a literal and applies 120 rows in 3 statements", async () => {
    const d1 = new MemoryD1();
    const rows = Array.from({ length: 120 }, (_, i) => ({
      url: `https://example.org/events?id=${i}&q=golf),(x`,
      found_via: "search_place",
      found_at: "2026-09-28T12:00:00.000Z",
      priority: 5,
      next_attempt_at: null,
      attempts: 0,
    }));
    const report = await d1.apply({ ops: [{ op: "upsert", table: "discovery_queue", rows }] });
    expect(report).toEqual({ statements: 3, files: 1 });
    const n = d1.db
      .prepare("SELECT count(*) AS n FROM discovery_queue WHERE url LIKE '%?id=%'")
      .get() as {
      n: number;
    };
    expect(n.n).toBe(120);
  });
});

describe("snapshot from a wrangler export dump", () => {
  it("loads a dump into SQLite in one transaction", () => {
    const src = migratedSqlite();
    src.exec(
      "INSERT INTO series (id, name, index_url) VALUES ('nkf', 'NKF Golf Classic', 'https://kidney.org/golf');",
    );
    // The shape `wrangler d1 export` writes: schema, then INSERTs.
    const dump = [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE series (id TEXT PRIMARY KEY, name TEXT NOT NULL, index_url TEXT NOT NULL);",
      `INSERT INTO "series" ("id","name","index_url") VALUES('nkf','NKF Golf Classic','https://kidney.org/golf');`,
    ].join("\n");
    const db = openSqlite(":memory:");
    loadDump(db, dump);
    const snap = snapshotOver(db);
    expect(
      snap.all(
        "SELECT * FROM series",
        z.object({ id: z.string(), name: z.string(), index_url: z.string() }),
      ),
    ).toEqual([{ id: "nkf", name: "NKF Golf Classic", index_url: "https://kidney.org/golf" }]);
    snap.close();
  });

  it("rolls back a broken dump", () => {
    const db = openSqlite(":memory:");
    expect(() => loadDump(db, "CREATE TABLE t (a);\nINSERT INTO nope VALUES (1);")).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get()).toEqual({
      n: 0,
    });
  });
});

describe("local D1 under --persist-to", () => {
  function persistDir(files: Record<string, boolean>): string {
    const root = mkdtempSync(join(tmpdir(), "gof-persist-"));
    const dir = join(root, "v3/d1/miniflare-D1DatabaseObject");
    mkdirSync(dir, { recursive: true });
    for (const [name, withOutings] of Object.entries(files)) {
      const db = openSqlite(join(dir, name));
      db.exec(withOutings ? "CREATE TABLE outings (id TEXT); INSERT INTO outings VALUES ('o1');" : "CREATE TABLE other (x);");
      db.close();
    }
    return root;
  }

  it("finds wrangler's database file (wrangler d1 export has no --persist-to)", () => {
    const root = persistDir({ "metadata.sqlite": false, "abc123.sqlite": true });
    expect(localD1File(root)).toBe(join(root, "v3/d1/miniflare-D1DatabaseObject/abc123.sqlite"));
    expect(() => localD1File(mkdtempSync(join(tmpdir(), "gof-empty-")))).toThrow(/no local D1/);
    const two = persistDir({ "a.sqlite": true, "b.sqlite": true });
    expect(() => localD1File(two)).toThrow(/more than one/);
  });

  it("copies it into the snapshot file with VACUUM INTO, leaving the source as it was", () => {
    const root = persistDir({ "metadata.sqlite": false, "abc123.sqlite": true });
    const out = join(mkdtempSync(join(tmpdir(), "gof-snap-")), "snapshot.sqlite");
    copyLocalD1(localD1File(root), out);
    const db = openSqlite(out, { readOnly: true });
    expect(db.prepare("SELECT id FROM outings").all()).toEqual([{ id: "o1" }]);
    db.close();
  });
});

describe("wrangler arguments", () => {
  it("exports and executes against remote or local, never with credentials on the command line", () => {
    expect(exportArgs({ target: "remote" }, "/tmp/x.sql")).toEqual([
      "d1",
      "export",
      "gof",
      "--remote",
      "--config",
      "wrangler.toml",
      "--output",
      "/tmp/x.sql",
    ]);
    expect(executeArgs({ target: "local", persistTo: "/data" }, "/tmp/p.sql")).toEqual([
      "d1",
      "execute",
      "gof",
      "--local",
      "--config",
      "wrangler.toml",
      "--file",
      "/tmp/p.sql",
      "--yes",
      "--persist-to",
      "/data",
    ]);
    expect(executeArgs({ target: "remote", persistTo: "/data" }, "/f.sql")).not.toContain(
      "--persist-to",
    );
    expect(executeArgs({ target: "remote" }, "/f.sql").join(" ")).not.toMatch(/token|account/i);
  });

  it("reads with --command --json and validates the rows", () => {
    expect(queryArgs({ target: "local" }, "SELECT 1 AS n")).toEqual([
      "d1",
      "execute",
      "gof",
      "--local",
      "--config",
      "wrangler.toml",
      "--json",
      "--command",
      "SELECT 1 AS n",
    ]);
    const out = JSON.stringify([{ results: [{ n: 1 }, { n: 2 }], success: true, meta: {} }]);
    expect(parseQueryOutput(out, z.object({ n: z.number() }))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(() => parseQueryOutput("[]", z.object({ n: z.number() }))).toThrow();
  });
});
