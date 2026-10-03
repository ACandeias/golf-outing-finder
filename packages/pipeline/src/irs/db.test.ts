import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBudget } from "@gof/shared/budget";
import { REPO_ROOT } from "../lib/paths.ts";
import { memoryLogger } from "../lib/logger.ts";
import { emptyOverrides } from "../overrides/load.ts";
import { parseCsv } from "../places/csv.ts";
import { memoryIrsLookup } from "../stages/irs-memory.ts";
import { irs } from "../stages/irs.ts";
import type { Context, IrsLookup } from "../stages/types.ts";
import { buildIrsDb, irsDbFileName, openIrsLookup, type SqliteIrsLookup } from "./db.ts";
import { fileTextChunks } from "./download.ts";
import { ensureIrsDb, IRS_FIXTURE_DB } from "./ensure.ts";

const FIXTURE = join(REPO_ROOT, "tests/fixtures/irs-subset.csv");

function ctx(now = "2026-10-01T10:30:00Z"): Context {
  return {
    now: new Date(now),
    caps: resolveBudget("monthly"),
    overrides: emptyOverrides(),
    log: memoryLogger(),
    clock: { nowMs: () => 0 },
  };
}

let dir: string;
let sqlite: SqliteIrsLookup;
let memory: IrsLookup;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gof-irs-"));
  const path = join(dir, "irs-2026-10.sqlite");
  const rep = await buildIrsDb(ctx(), path, [{ name: "fixture", chunks: fileTextChunks(FIXTURE) }], {
    batchSize: 5,
  });
  expect(rep.records).toBe(22);
  sqlite = openIrsLookup(path);
  memory = memoryIrsLookup(irs(ctx(), { rows: parseCsv(await readFile(FIXTURE, "utf8")) }).output.records);
});

afterAll(async () => {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

describe("node:sqlite IRS lookup built from irs-subset.csv", () => {
  it("finds records by EIN, ignoring punctuation", () => {
    expect(sqlite.byEin("99-0000118")).toEqual({
      ein: "990000118",
      name: "BOYS CLUB OF NEW YORK",
      city: "NEW YORK",
      state: "NY",
      subsection: "03",
      sort_name: "BCNY",
    });
    expect(sqlite.byEin("000000000")).toBeNull();
  });

  it("returns the same candidates as memoryIrsLookup", () => {
    const queries: [string, string | null][] = [
      ["National Kidney Foundation", "PA"],
      ["National Kidney Foundation", null],
      ["BCNY", "NY"],
      ["Hope & Heroes", "NY"],
      ["The Builders Institute", "NY"],
      ["American Cancer Society", "IL"],
      ["American Cancer Society", null],
      ["Fordham University Golf Classic", "ny"],
      ["Foundation Inc", null],
      ["", null],
      ["Ronald McDonald House Charities St. Louis", "MO"],
    ];
    for (const [name, state] of queries) {
      for (const limit of [1, 3, 25]) {
        expect(sqlite.candidates(name, state, limit), `${name} ${state} ${limit}`).toEqual(
          memory.candidates(name, state, limit),
        );
      }
    }
    expect(sqlite.candidates("National Kidney Foundation", null, 5)[0]?.ein).toBe("990000101");
  });

  it("records build metadata", () => {
    expect(sqlite.meta()).toMatchObject({ month: "2026-10", records: "22", schema_version: "1" });
  });
});

describe("buildIrsDb", () => {
  it("refuses to replace a database with an empty build", async () => {
    async function* empty() {
      yield "EIN,NAME,CITY,STATE,SUBSECTION\n";
    }
    const path = join(dir, "empty.sqlite");
    await expect(buildIrsDb(ctx(), path, [{ name: "e", chunks: empty() }])).rejects.toThrow(/no records/);
  });

  it("names the file by the run month", () => {
    expect(irsDbFileName(new Date("2026-10-01T10:30:00Z"))).toBe("irs-2026-10.sqlite");
  });
});

describe("ensureIrsDb", () => {
  it("builds the fixture database in a dry run without the network", async () => {
    const d = await mkdtemp(join(tmpdir(), "gof-irs-dry-"));
    const res = await ensureIrsDb({ ctx: ctx(), dir: d, mode: "dry-run", fixturePath: FIXTURE });
    expect(res).toMatchObject({ path: join(d, IRS_FIXTURE_DB), built: true, records: 22 });
    await rm(d, { recursive: true, force: true });
  });

  it("downloads and builds when the month file is missing, then reuses it", async () => {
    const d = await mkdtemp(join(tmpdir(), "gof-irs-live-"));
    const csv = await readFile(FIXTURE, "utf8");
    const urls: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(new Headers(init.headers).get("user-agent")).toMatch(/^GolfOutingFinderBot\/1\.0/);
      // Every regional file gets the same rows; duplicates by EIN are skipped.
      return new Response(csv, { status: 200 });
    };
    const http = { userAgent: "GolfOutingFinderBot/1.0 (+http://localhost:8787/bot)", fetch };
    const first = await ensureIrsDb({ ctx: ctx(), dir: d, mode: "live", fixturePath: FIXTURE, http });
    expect(first).toMatchObject({ path: join(d, "irs-2026-10.sqlite"), built: true, records: 22 });
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u.startsWith("https://www.irs.gov/pub/irs-soi/eo"))).toBe(true);
    const again = await ensureIrsDb({ ctx: ctx(), dir: d, mode: "live", fixturePath: FIXTURE, http });
    expect(again).toMatchObject({ built: false, records: 22 });
    expect(urls).toHaveLength(4);
    await rm(d, { recursive: true, force: true });
  });

  it("falls back to an earlier month when the download fails", async () => {
    const d = await mkdtemp(join(tmpdir(), "gof-irs-fallback-"));
    await buildIrsDb(ctx("2026-09-01T10:30:00Z"), join(d, "irs-2026-09.sqlite"), [
      { name: "fixture", chunks: fileTextChunks(FIXTURE) },
    ]);
    await writeFile(join(d, "unrelated.txt"), "x");
    const fetch = async () => new Response("nope", { status: 404 });
    const res = await ensureIrsDb({
      ctx: ctx(),
      dir: d,
      mode: "live",
      fixturePath: FIXTURE,
      http: { userAgent: "GolfOutingFinderBot/1.0 (+x/bot)", fetch, sleep: async () => {} },
    });
    expect(res).toMatchObject({ path: join(d, "irs-2026-09.sqlite"), fallback: true, records: 22 });
    expect(res.error).toMatch(/HTTP 404/);
    await rm(d, { recursive: true, force: true });
  });
});
