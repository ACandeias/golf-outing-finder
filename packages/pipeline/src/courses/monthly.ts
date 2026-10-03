import { z } from "zod";
import { US_STATES } from "@gof/shared/places";
import { PATHS } from "../lib/paths.ts";
import { readPlaces } from "../places/files.ts";
import type { HandlerOutcome, StageEnv, StageHandler } from "../run/handlers.ts";
import { timeZoneAt as defaultTimeZoneAt } from "../seed/context.ts";
import { courses } from "../stages/courses.ts";
import { courseRowSchema } from "../stages/rows.ts";
import {
  emptyResult,
  type CourseRow,
  type OsmFeatureInput,
  type PlaceCity,
  type StageResult,
} from "../stages/types.ts";
import { fixtureFeatures, readCoursesFixture } from "./fixture.ts";
import { fetchOverpass, stateQuery, toOsmFeatures, type OsmFeature } from "./overpass.ts";

/**
 * Edge for the monthly courses stage (SPEC.md 8.1 step 1): Overpass one state at
 * a time with backoff on 429 and timeouts, each state's courses written as soon
 * as it is done, and `courses:XX` recorded in `runs.stages_done` so a killed or
 * capped run resumes after the last completed state. A dry run reads
 * tests/fixtures/courses.json and never touches the network.
 */

export const PROGRESS_PREFIX = "courses:";
/** Overpass server-side timeout per state query. */
export const OVERPASS_TIMEOUT_SEC = 180;
/** Pause between states: the public instance asks for no parallel or rapid-fire use. */
export const STATE_PAUSE_MS = 10_000;

export interface CoursesHandlerDeps {
  /** Features for one state. Defaults: Overpass (live), the fixture (dry run). */
  featuresFor?: (state: string, env: StageEnv) => Promise<OsmFeature[]>;
  /** States to import, in order. Defaults: every state and DC (live), the fixture's states (dry run). */
  states?: (env: StageEnv) => Promise<string[]>;
  timeZoneAt?: (lat: number, lng: number) => string;
  /** City centroids for the 30 km city fallback when the cities table is empty. */
  placesFallback?: () => Promise<PlaceCity[]>;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
  fixturePath?: string;
}

const runProgressRow = z.object({ id: z.string(), stages_done: z.string() });
const placeRow = z.object({
  name: z.string(),
  state: z.string(),
  lat: z.number(),
  lng: z.number(),
});

/** States completed by earlier monthly runs this calendar month, or "all" when one finished the stage. */
export function completedStates(
  rows: readonly { id: string; stages_done: string }[],
  currentRunId: string,
): Set<string> | "all" {
  const done = new Set<string>();
  for (const r of rows) {
    if (r.id === currentRunId) continue;
    let list: unknown;
    try {
      list = JSON.parse(r.stages_done);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === "courses") return "all";
      if (typeof entry === "string" && entry.startsWith(PROGRESS_PREFIX)) {
        done.add(entry.slice(PROGRESS_PREFIX.length));
      }
    }
  }
  return done;
}

function botUserAgent(): string {
  const site = process.env.PUBLIC_SITE_URL ?? "http://localhost:8787";
  return `GolfOutingFinderBot/1.0 (+${site.replace(/\/$/, "")}/bot)`;
}

function merge(into: StageResult, add: StageResult): void {
  for (const [k, v] of Object.entries(add.counters)) {
    const key = k as keyof StageResult["counters"];
    into.counters[key] = (into.counters[key] ?? 0) + (v ?? 0);
  }
  into.budgetHits.push(...add.budgetHits);
  into.errors.push(...add.errors);
  into.holds.push(...add.holds);
}

export function coursesHandler(deps: CoursesHandlerDeps = {}): StageHandler {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fixturePath = deps.fixturePath ?? PATHS.coursesFixture;

  return async (env): Promise<HandlerOutcome> => {
    const { ctx, guard, snapshot } = env;
    const result = emptyResult();
    const month = ctx.now.toISOString().slice(0, 7);

    const prior = completedStates(
      snapshot.all(
        `SELECT id, stages_done FROM runs WHERE kind = 'monthly' AND substr(started_at, 1, 7) = '${month}'`,
        runProgressRow,
      ),
      env.runId,
    );
    if (prior === "all") {
      ctx.log.info("courses already imported by an earlier monthly run this month; skipping");
      return { result };
    }

    let fixture: Awaited<ReturnType<typeof readCoursesFixture>> | null = null;
    const loadFixture = async () => (fixture ??= await readCoursesFixture(fixturePath));
    const states = deps.states
      ? await deps.states(env)
      : env.mode === "dry-run"
        ? Object.keys((await loadFixture()).states).sort()
        : Object.keys(US_STATES).sort();
    const featuresFor =
      deps.featuresFor ??
      (env.mode === "dry-run"
        ? async (state: string) => fixtureFeatures(await loadFixture(), [state])
        : async (state: string) =>
            toOsmFeatures(
              await fetchOverpass(stateQuery(state, OVERPASS_TIMEOUT_SEC), {
                userAgent: deps.userAgent ?? botUserAgent(),
                sleep,
                attempts: 5,
                baseDelayMs: 30_000,
                timeoutMs: (OVERPASS_TIMEOUT_SEC + 60) * 1000,
              }),
              state,
            ));

    const existing: CourseRow[] = snapshot.all("SELECT * FROM courses", courseRowSchema);
    const existingByRef = new Map(existing.filter((c) => c.osm_ref).map((c) => [c.osm_ref!, c]));
    let places: PlaceCity[] = snapshot.all("SELECT name, state, lat, lng FROM cities", placeRow);
    if (places.length === 0) {
      places = deps.placesFallback
        ? await deps.placesFallback()
        : (await readPlaces(PATHS.places)).cities.map((c) => ({
            name: c.name,
            state: c.state,
            lat: c.lat,
            lng: c.lng,
          }));
    }

    const todo = states.filter((s) => !prior.has(s));
    if (todo.length < states.length) {
      ctx.log.info("resuming the courses import", {
        done: states.length - todo.length,
        left: todo.length,
      });
    }
    const seen = new Set<string>();
    let first = true;
    for (const state of todo) {
      if (!guard.check("MAX_FETCHES_PER_RUN", 1, "courses")) break;
      if (!first && env.mode === "live") await sleep(deps.pauseMs ?? STATE_PAUSE_MS);
      first = false;
      let feats: OsmFeature[];
      try {
        feats = await featuresFor(state, env);
      } catch (err) {
        const message = `Overpass ${state}: ${err instanceof Error ? err.message : String(err)}`;
        ctx.log.error("courses state failed; the next run retries it", { state, error: message });
        result.errors.push({ stage: "courses", kind: "network", message });
        result.counters.fetch_errors = (result.counters.fetch_errors ?? 0) + 1;
        continue;
      }
      const features: OsmFeatureInput[] = [];
      for (const f of feats) {
        // A course on a state line comes back for both states; the first one wins,
        // and a course already stored under another state stays there.
        const prev = existingByRef.get(f.osmRef);
        if (seen.has(f.osmRef) || (prev && prev.state !== state)) continue;
        seen.add(f.osmRef);
        features.push({ osm_ref: f.osmRef, state, lat: f.lat, lng: f.lng, tags: f.tags });
      }
      const out = courses(ctx, {
        features,
        existing,
        places,
        websiteTypes: {},
        timeZoneAt: deps.timeZoneAt ?? defaultTimeZoneAt,
      });
      if (out.output.plan.ops.length > 0) await env.d1.apply(out.output.plan);
      merge(result, out.result);
      await env.markProgress(`${PROGRESS_PREFIX}${state}`);
      ctx.log.info("courses state done", {
        state,
        courses: out.result.counters.courses_imported ?? 0,
        dropped: out.output.dropped.length,
      });
    }
    return { result };
  };
}
