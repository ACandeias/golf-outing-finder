import { z } from "zod";
import type { HandlerOutcome, StageEnv, StageHandler } from "../run/handlers.ts";
import {
  courseTypeCandidates,
  courseTypesCollect,
  courseTypesRequestBuild,
} from "../stages/course-types.ts";
import { courseRowSchema } from "../stages/rows.ts";
import {
  COUNTS_AS_FETCH_ERROR,
  emptyResult,
  NORMALIZED_TEXT_MAX,
  type BatchClient,
  type CourseRow,
  type FetchPlanItem,
  type PageFetcher,
  type StageResult,
  type UpsertPlan,
} from "../stages/types.ts";
import { COURSE_PAGE_TEXT_MAX } from "./course-type-prompt.ts";
import {
  anthropicBatchClient,
  fixtureBatchClient,
  fixturePageFetcher,
} from "./course-types-ports.ts";
import { findAboutLink, htmlToText } from "./site-text.ts";

/**
 * Edge for the monthly course-types stage (SPEC.md 8.1 steps 4.3 and 5):
 *
 * 1. Collect a batch an earlier monthly run left in `runs.pending_batch_id`.
 * 2. Pick `unknown` courses with a website and no override, outings first, up to
 *    MAX_COURSE_CLASSIFICATIONS_PER_RUN.
 * 3. Fetch each homepage and one about or membership page through the injected
 *    PageFetcher (workstream B's, behind the SSRF guard and robots cache), eight
 *    courses at a time, within MAX_FETCHES_PER_RUN, the per-host cap and
 *    MAX_FETCH_MINUTES.
 * 4. Build the batch (pure stage), submit, poll every 60 s for up to 45 min,
 *    collect and write the accepted types; a batch still running is stored in
 *    this run's `pending_batch_id` for the next monthly run.
 *
 * A dry run uses tests/fixtures/course-types (fixture fetcher and batch client).
 */

export interface CourseTypesHandlerDeps {
  fetcher?: PageFetcher;
  batch?: BatchClient;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Courses fetched in parallel (distinct hosts; the fetcher spaces each host). */
  concurrency?: number;
  fixtureDir?: string;
}

export const POLL_INTERVAL_MS = 60_000;
export const POLL_TIMEOUT_MS = 45 * 60_000;

const pendingRow = z.object({ id: z.string(), pending_batch_id: z.string() });

function fetchItem(url: string): FetchPlanItem {
  return {
    url,
    found_via: "search_course",
    kind: "search",
    priority: 9,
    bypass_dedupe: true,
    recheck_outing_id: null,
    directory_host: null,
    render: false,
    host: new URL(url).hostname.toLowerCase(),
  };
}

function mergeInto(into: StageResult, add: StageResult): void {
  for (const [k, v] of Object.entries(add.counters)) {
    const key = k as keyof StageResult["counters"];
    into.counters[key] = (into.counters[key] ?? 0) + (v ?? 0);
  }
  into.budgetHits.push(...add.budgetHits);
  into.errors.push(...add.errors);
  into.holds.push(...add.holds);
}

async function pool<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

export function courseTypesHandler(deps: CourseTypesHandlerDeps = {}): StageHandler {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxPolls = Math.max(1, Math.floor((deps.pollTimeoutMs ?? POLL_TIMEOUT_MS) / interval));

  return async (env: StageEnv): Promise<HandlerOutcome> => {
    const { ctx, guard } = env;
    const result = emptyResult();
    const plan: UpsertPlan = { ops: [] };
    const nowIso = () => ctx.now.toISOString();

    const batch: BatchClient | null =
      deps.batch ??
      env.ports.batch ??
      (env.mode === "dry-run" ? await fixtureBatchClient(deps.fixtureDir) : null);
    const lazyLiveBatch = (): BatchClient => anthropicBatchClient();

    const unknownCourses = async (): Promise<CourseRow[]> =>
      env.d1.query(
        "SELECT * FROM courses WHERE course_type = 'unknown' AND website IS NOT NULL",
        courseRowSchema,
      );

    const collect = async (client: BatchClient, batchId: string): Promise<void> => {
      const results = await client.results(batchId);
      const out = courseTypesCollect(ctx, { results, courses: await unknownCourses() });
      mergeInto(result, out.result);
      plan.ops.push(...out.output.plan.ops);
      let output = 0;
      for (const r of results) {
        if (r.result.type === "succeeded") output += r.result.message.usage.output_tokens;
      }
      guard.recordOutputTokens(output);
      ctx.log.info("course types collected", {
        batch_id: batchId,
        accepted: out.output.accepted.length,
        rejected: out.output.rejected.length,
      });
    };

    const waitForEnd = async (
      client: BatchClient,
      batchId: string,
      first: string,
    ): Promise<boolean> => {
      let status = first;
      for (let i = 0; status !== "ended" && i < maxPolls; i++) {
        await sleep(interval);
        status = (await client.poll(batchId)).status;
      }
      return status === "ended";
    };

    // 1. A batch an earlier monthly run left pending.
    const month = ctx.now.toISOString().slice(0, 7);
    const pending = env.snapshot
      .all(
        `SELECT id, pending_batch_id FROM runs WHERE kind = 'monthly' AND pending_batch_id IS NOT NULL ` +
          `AND id <> '${env.runId.replace(/'/g, "''")}' ORDER BY started_at DESC`,
        pendingRow,
      )
      .at(0);
    if (pending) {
      const client = batch ?? lazyLiveBatch();
      const st = await client.poll(pending.pending_batch_id);
      if (st.status !== "ended") {
        ctx.log.info("an earlier course-type batch is still running; not submitting another", {
          batch_id: pending.pending_batch_id,
        });
        return { result };
      }
      await collect(client, pending.pending_batch_id);
      plan.ops.push({
        op: "update",
        table: "runs",
        set: { pending_batch_id: null },
        where: { id: pending.id },
      });
      await env.d1.apply(plan);
      plan.ops.length = 0;
    }

    // 2. Candidates, outings first.
    if (guard.paidWorkBlocked) return { result, ...(plan.ops.length ? { plan } : {}) };
    const allowance = guard.allowance();
    const limit = allowance.MAX_COURSE_CLASSIFICATIONS_PER_RUN ?? 0;
    const candidates = courseTypeCandidates(await unknownCourses(), ctx.overrides).slice(0, limit);
    if (candidates.length === 0) {
      ctx.log.info("no courses to classify", { month });
      return { result };
    }

    // 3. Pages.
    const fetcher: PageFetcher | null =
      deps.fetcher ??
      env.ports.fetcher ??
      (env.mode === "dry-run" ? await fixturePageFetcher(nowIso, deps.fixtureDir) : null);
    if (!fetcher) {
      result.errors.push({
        stage: "course-types",
        kind: "internal",
        message: "no PageFetcher wired for a live run (ports.fetcher); course pages not fetched",
      });
      return { result };
    }
    const pages: { course_id: string; url: string; text: string }[] = [];
    let stopped = false;
    const get = async (url: string): Promise<string | null> => {
      if (stopped) return null;
      if (!guard.checkFetchMinutes("course-types")) {
        stopped = true;
        return null;
      }
      let item: FetchPlanItem;
      try {
        item = fetchItem(url);
      } catch {
        return null;
      }
      if (!guard.checkHost(item.host, "course-types")) return null;
      if (guard.remaining("MAX_FETCHES_PER_RUN") <= 0) {
        guard.recordHit("MAX_FETCHES_PER_RUN", "course-types");
        stopped = true;
        return null;
      }
      try {
        const page = await fetcher.fetchPage(item, guard);
        if (COUNTS_AS_FETCH_ERROR.has(page.outcome)) {
          result.counters.fetch_errors = (result.counters.fetch_errors ?? 0) + 1;
        }
        return page.outcome === "ok" && page.html ? page.html : null;
      } catch (err) {
        if (guard.remaining("MAX_FETCHES_PER_RUN") <= 0) stopped = true;
        else ctx.log.warn("course page fetch failed", { url, error: String(err) });
        return null;
      }
    };
    await pool(candidates, deps.concurrency ?? 8, async (course) => {
      const home = course.website ? await get(course.website) : null;
      if (!home) return;
      pages.push({
        course_id: course.id,
        url: course.website!,
        text: htmlToText(home, Math.min(COURSE_PAGE_TEXT_MAX * 2, NORMALIZED_TEXT_MAX)),
      });
      const about = findAboutLink(home, course.website!);
      const aboutHtml = about ? await get(about) : null;
      if (about && aboutHtml) {
        pages.push({
          course_id: course.id,
          url: about,
          text: htmlToText(aboutHtml, Math.min(COURSE_PAGE_TEXT_MAX * 2, NORMALIZED_TEXT_MAX)),
        });
      }
    });

    // 4. Build, submit, poll, collect.
    const built = courseTypesRequestBuild(ctx, {
      courses: candidates,
      pages,
      allowance: guard.allowance(),
    });
    mergeInto(result, built.result);
    guard.addHits(built.result.budgetHits);
    const requests = built.output.requests;
    if (requests.length === 0) return { result };
    const tokens = requests.reduce((s, r) => s + r.est_input_tokens, 0);
    if (
      !guard.check("MAX_COURSE_CLASSIFICATIONS_PER_RUN", requests.length, "course-types") ||
      !guard.check("MAX_LLM_INPUT_TOKENS_PER_RUN", tokens, "course-types")
    ) {
      return { result };
    }
    const client = batch ?? lazyLiveBatch();
    const submitted = await client.submit(requests);
    ctx.log.info("course-type batch submitted", {
      batch_id: submitted.batch_id,
      requests: requests.length,
      est_input_tokens: tokens,
    });
    if (!(await waitForEnd(client, submitted.batch_id, submitted.status))) {
      ctx.log.info("course-type batch still running; the next monthly run collects it", {
        batch_id: submitted.batch_id,
      });
      return { result, pendingBatchId: submitted.batch_id };
    }
    await collect(client, submitted.batch_id);
    return { result, plan, pendingBatchId: null };
  };
}
