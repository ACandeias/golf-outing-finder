/**
 * `pnpm run test:live-extract` (SPEC.md 11): re-records the LLM fixtures in
 * tests/fixtures/llm/{id}.json by sending every page in tests/fixtures/pages
 * through the real extraction batch. It costs money, so it:
 *
 * - exits 1 before anything else when ANTHROPIC_API_KEY is not set;
 * - prints the request count and an estimated cost, and submits only after the
 *   owner types "yes" on stdin;
 * - checks MAX_EXTRACTIONS_PER_RUN and MAX_LLM_INPUT_TOKENS_PER_RUN through the
 *   budget guard (nightly profile, env overrides apply);
 * - polls every 60 s for up to 45 min; when the batch is still running it
 *   prints the batch id and exits 3, and `-- --batch-id=<id>` collects it later
 *   without submitting again;
 * - writes `{ id, recorded: true, recorded_at, model, extractor_version,
 *   batch_result }` over the hand-written stand-ins, and refuses to write a file
 *   that contains the API key or anything shaped like an Anthropic key.
 *
 * Requests are built exactly as the golden harness builds them (now pinned to
 * 2026-09-28T12:00Z, fetched_at the same), so a recording replays byte for byte.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { BudgetGuard, RATES_MICROCENTS } from "./budget.ts";
import { sha256Hex } from "./extract/ids.ts";
import { EXTRACT_MAX_TOKENS, EXTRACT_MODEL, EXTRACTOR_VERSION } from "./extract/prompt.ts";
import { createLogger } from "./lib/logger.ts";
import { PATHS, REPO_ROOT } from "./lib/paths.ts";
import { AnthropicBatchClient, runExtractionBatch } from "./llm/batch-client.ts";
import { llmRecordingSchema, type LlmRecording } from "./llm/recording.ts";
import { loadOverrides } from "./overrides/load.ts";
import { readSeedFile, type SeedEntry } from "./seed/seed-file.ts";
import { extractRequestBuild } from "./stages/extract-request-build.ts";
import {
  normalizedPageSchema,
  type BatchResult,
  type Context,
  type ExtractionRequest,
  type FoundVia,
  type NormalizedPage,
} from "./stages/types.ts";

export const PAGES_DIR = join(REPO_ROOT, "tests/fixtures/pages");
export const LLM_DIR = join(REPO_ROOT, "tests/fixtures/llm");
/** The golden harness's pinned clock (SPEC.md 11). */
export const RECORDING_NOW = new Date("2026-09-28T12:00:00.000Z");
/** Typical output per page, for the estimate; the cap is EXTRACT_MAX_TOKENS. */
const TYPICAL_OUTPUT_TOKENS = 500;

export interface FixturePage {
  id: string;
  page: NormalizedPage;
}

function foundViaFor(kind: NormalizedPage["kind"]): FoundVia {
  if (kind === "directory" || kind === "association" || kind === "platform") return kind;
  return "search_place";
}

/** One normalized page per fixture id, `{id}.synthetic.json` preferred, as the harness loads them. */
export function loadFixturePages(pagesDir: string, seed: readonly SeedEntry[]): FixturePage[] {
  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".json"));
  const ids = [...new Set(files.map((f) => f.replace(/\.synthetic\.json$|\.json$/, "")))].sort();
  return ids.map((id) => {
    const synthetic = join(pagesDir, `${id}.synthetic.json`);
    const path = existsSync(synthetic) ? synthetic : join(pagesDir, `${id}.json`);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      url: string | null;
      http_status: number | null;
      text: string;
      jsonld: unknown[];
    };
    const entry = seed.find((e) => e.id === id);
    const kind = entry?.source_kind ?? "organizer";
    const url = raw.url ?? entry?.source_url ?? `https://fixtures.invalid/${id}`;
    const text = raw.text.slice(0, 12_000);
    return {
      id,
      page: normalizedPageSchema.parse({
        url,
        kind,
        found_via: foundViaFor(kind),
        fetched_at: RECORDING_NOW.toISOString(),
        http_status: raw.http_status,
        text,
        jsonld: raw.jsonld,
        jsonld_events: [],
        hash: sha256Hex(text),
        unchanged: false,
        needs_render: false,
        rendered: entry?.render_required ?? false,
        recheck_outing_id: null,
        directory_host: kind === "directory" ? new URL(url).hostname : null,
      }),
    };
  });
}

/** Estimated cost in cents at batch prices: typical output, and the ceiling at max_tokens. */
export function estimateCostCents(requests: readonly ExtractionRequest[]): { typical: number; ceiling: number } {
  const input = requests.reduce((n, r) => n + r.est_input_tokens, 0);
  const cents = (outPerPage: number) =>
    Math.ceil(
      (input * RATES_MICROCENTS.llmInputPerToken +
        requests.length * outPerPage * RATES_MICROCENTS.llmOutputPerToken) /
        1_000_000,
    );
  return { typical: cents(TYPICAL_OUTPUT_TOKENS), ceiling: cents(EXTRACT_MAX_TOKENS) };
}

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{10,}/;

/** True when `text` holds the key itself or anything shaped like an Anthropic key. */
export function containsSecret(text: string, apiKey: string | undefined): boolean {
  return KEY_SHAPE.test(text) || (apiKey !== undefined && apiKey.length > 0 && text.includes(apiKey));
}

export function toRecording(id: string, result: BatchResult, recordedAt: Date): LlmRecording {
  return llmRecordingSchema.parse({
    id,
    recorded: true,
    recorded_at: recordedAt.toISOString(),
    model: EXTRACT_MODEL,
    extractor_version: EXTRACTOR_VERSION,
    batch_result: result,
  });
}

function argValue(argv: readonly string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

export async function runLiveExtract(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("live-extract: ANTHROPIC_API_KEY is not set; nothing was sent.");
    return 1;
  }
  const log = createLogger({ level: "info", secrets: [apiKey] });
  const seed = await readSeedFile(PATHS.seed);
  const overrides = await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places });
  const guard = new BudgetGuard({ profile: "nightly", env: process.env, now: RECORDING_NOW });
  const ctx: Context = { now: RECORDING_NOW, caps: guard.caps, overrides, log, clock: { nowMs: () => Date.now() } };

  const pages = loadFixturePages(PAGES_DIR, seed.outings);
  const built = extractRequestBuild(ctx, { pages: pages.map((p) => p.page), allowance: guard.allowance() });
  const idByCustomId = new Map<string, string>();
  for (const r of built.output.requests) {
    const p = pages.find((x) => x.page.url === r.page_url);
    if (p) idByCustomId.set(r.custom_id, p.id);
  }
  if (built.output.deferred.length > 0)
    console.warn(`live-extract: ${built.output.deferred.length} page(s) over the caps are left out.`);

  const resume = argValue(argv, "batch-id");
  const cost = estimateCostCents(built.output.requests);
  if (!resume) {
    console.log(
      `live-extract: ${built.output.requests.length} requests to ${EXTRACT_MODEL} through the Message Batches API.\n` +
        `Estimated cost: about $${(cost.typical / 100).toFixed(2)}, at most $${(cost.ceiling / 100).toFixed(2)}.`,
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Type "yes" to submit: ')).trim().toLowerCase();
    rl.close();
    if (answer !== "yes") {
      console.log("live-extract: not confirmed; nothing was sent.");
      return 1;
    }
  }

  const client = new AnthropicBatchClient(new Anthropic());
  const out = await runExtractionBatch(client, resume ? [] : built.output.requests, {
    pendingBatchId: resume,
    budget: guard,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nowMs: () => Date.now(),
  });
  if (out.status === "pending") {
    console.log(
      `live-extract: batch ${out.batchId} is still running. Collect it later with\n` +
        `  pnpm run test:live-extract -- --batch-id=${out.batchId}`,
    );
    return 3;
  }
  if (out.submitted === 0 && !resume) {
    console.error("live-extract: the budget guard refused the batch; nothing was sent.");
    return 1;
  }

  const recordedAt = new Date();
  let written = 0;
  for (const result of out.results) {
    const id = idByCustomId.get(result.custom_id);
    if (!id) {
      console.warn(`live-extract: result for unknown custom_id ${result.custom_id} skipped`);
      continue;
    }
    if (result.result.type !== "succeeded") {
      console.warn(`live-extract: ${id}: ${result.result.type}; the old fixture stays`);
      continue;
    }
    const text = `${JSON.stringify(toRecording(id, result, recordedAt), null, 2)}\n`;
    if (containsSecret(text, apiKey)) {
      console.error(`live-extract: ${id}: output looks like it holds a credential; not written`);
      continue;
    }
    writeFileSync(join(LLM_DIR, `${id}.json`), text);
    written++;
  }
  console.log(`live-extract: wrote ${written} recording(s) to tests/fixtures/llm/.`);
  return written > 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveExtract().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
