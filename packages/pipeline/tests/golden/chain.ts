import { expect } from "vitest";
import { classify } from "../../src/stages/classify.ts";
import { extractCollect } from "../../src/stages/extract-collect.ts";
import { extractRequestBuild } from "../../src/stages/extract-request-build.ts";
import { match } from "../../src/stages/match.ts";
import type { SeedEntry } from "../../src/seed/seed-file.ts";
import type {
  ClassifiedOuting,
  ExtractedEvent,
  ExtractedPage,
  MatchedOuting,
} from "../../src/stages/types.ts";
import {
  goldenContext,
  irsLookup,
  loadCourses,
  loadLlmRecording,
  loadPageFixture,
  toNormalizedPage,
} from "./harness.ts";

/**
 * Runs a seed entry's page through the extraction stages with its recorded
 * Message Batches result, then classify and match. Every golden case that needs
 * the LLM goes through here, so the chain is defined once.
 */
export async function extractPage(entry: SeedEntry): Promise<ExtractedPage> {
  const ctx = await goldenContext();
  const page = toNormalizedPage(entry, await loadPageFixture(entry.id));
  const built = extractRequestBuild(ctx, {
    pages: [page],
    allowance: {
      MAX_EXTRACTIONS_PER_RUN: ctx.caps.MAX_EXTRACTIONS_PER_RUN,
      MAX_LLM_INPUT_TOKENS_PER_RUN: ctx.caps.MAX_LLM_INPUT_TOKENS_PER_RUN,
    },
  });
  expect(built.output.requests).toHaveLength(1);
  const meta = built.output.meta[0];
  if (!meta) throw new Error("extract-request-build returned no meta");
  const rec = await loadLlmRecording(entry.id);
  if (rec.status !== "recorded") throw new Error(rec.message);
  const collected = extractCollect(ctx, {
    results: [{ ...rec.recording.batch_result, custom_id: meta.custom_id }],
    meta: built.output.meta,
  });
  const out = collected.output.pages[0];
  if (!out) throw new Error(`extract-collect returned no page for ${entry.id}`);
  return out;
}

export async function classifyEvents(events: ExtractedEvent[]): Promise<ClassifiedOuting[]> {
  const ctx = await goldenContext();
  return classify(ctx, { events, irs: await irsLookup() }).output.outings;
}

export async function matchOutings(outings: ClassifiedOuting[]): Promise<MatchedOuting[]> {
  const ctx = await goldenContext();
  const { courses, places } = await loadCourses();
  return match(ctx, { outings, courses, places }).output.outings;
}

/** The event on the page that is the seed entry (one event, or the one on the seed's date). */
export function pickEvent<E extends ExtractedEvent>(
  events: readonly E[],
  entry: SeedEntry,
  courseHint?: RegExp,
): E {
  if (events.length === 1 && !courseHint) return events[0] as E;
  const found = events.find(
    (e) =>
      (entry.start_date ? e.start_date === entry.start_date : true) &&
      (courseHint ? courseHint.test(e.course_name ?? "") : true),
  );
  if (!found) throw new Error(`no event for ${entry.id} among ${events.length}`);
  return found;
}

/** The full chain for one entry: extracted page, the entry's event, classified and matched. */
export async function runEntry(entry: SeedEntry, courseHint?: RegExp) {
  const page = await extractPage(entry);
  const event = pickEvent(page.events, entry, courseHint);
  const [classified] = await classifyEvents([event]);
  if (!classified) throw new Error("classify returned nothing");
  const [matched] = await matchOutings([classified]);
  if (!matched) throw new Error("match returned nothing");
  return { page, event, classified, matched };
}

/** The matched course row, for course-type assertions. */
export async function courseOf(m: MatchedOuting) {
  if (m.match.kind !== "matched")
    throw new Error(`course ${m.match.kind} for ${m.course_name ?? "?"}`);
  const { courses } = await loadCourses();
  const id = m.match.course_id;
  const c = courses.find((x) => x.id === id);
  if (!c) throw new Error(`matched course ${id} not in fixtures`);
  return c;
}
