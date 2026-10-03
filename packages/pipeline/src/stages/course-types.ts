import { courseTypeAnswerSchema } from "../courses/course-type-output.ts";
import { courseTypeOutputFormat } from "../courses/course-type-output.ts";
import {
  buildCourseTypeMessage,
  COURSE_TYPE_MAX_TOKENS,
  COURSE_TYPE_MODEL,
  COURSE_TYPE_SYSTEM_PROMPT,
  estimateTokens,
} from "../courses/course-type-prompt.ts";
import { WEBSITE_CONFIDENCE_MIN } from "../courses/import.ts";
import type { Overrides } from "../overrides/load.ts";
import {
  emptyResult,
  type BatchResult,
  type BudgetHit,
  type CourseRow,
  type CourseTypesCollectStage,
  type CourseTypesRequestBuildStage,
  type ExtractionRequest,
  type UpsertPlan,
} from "./types.ts";

/**
 * SPEC.md 8.1 step 4.3, workstream D (monthly). Batch requests that classify a
 * course from its homepage and an about or membership page (prompt in
 * prompts/course-type.md), within MAX_COURSE_CLASSIFICATIONS_PER_RUN and
 * MAX_LLM_INPUT_TOKENS_PER_RUN, courses with outings first; collect accepts
 * confidence 0.7 or higher and only ever fills a course that is still `unknown`
 * and has no course-types.yaml override.
 */

const OUTPUT_FORMAT = courseTypeOutputFormat();
const FIXED_CHARS = COURSE_TYPE_SYSTEM_PROMPT.length + JSON.stringify(OUTPUT_FORMAT).length;

/** custom_id for a course: its osm_ref with `/` as `-` (stable across imports), else its id. */
export function courseTypeCustomId(course: Pick<CourseRow, "id" | "osm_ref">): string {
  return (course.osm_ref ?? course.id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

export function hasCourseTypeOverride(
  course: Pick<CourseRow, "id" | "osm_ref">,
  overrides: Pick<Overrides, "courseTypes">,
): boolean {
  return overrides.courseTypes.some(
    (o) => (o.osm_ref !== undefined && o.osm_ref === course.osm_ref) || o.course_id === course.id,
  );
}

/** Courses the classifier may take, outings first (SPEC.md 8.1 step 5). */
export function courseTypeCandidates(
  courses: readonly CourseRow[],
  overrides: Pick<Overrides, "courseTypes">,
): CourseRow[] {
  return courses
    .filter(
      (c) =>
        c.course_type === "unknown" &&
        c.website !== null &&
        /^https?:\/\//i.test(c.website) &&
        !hasCourseTypeOverride(c, overrides),
    )
    .sort(
      (a, b) =>
        b.outing_count - a.outing_count ||
        b.notable - a.notable ||
        (b.last_outing_date ?? "").localeCompare(a.last_outing_date ?? "") ||
        a.id.localeCompare(b.id),
    );
}

export const courseTypesRequestBuild: CourseTypesRequestBuildStage = (ctx, input) => {
  const result = emptyResult();
  const requests: ExtractionRequest[] = [];
  const deferred: string[] = [];
  const maxRequests =
    input.allowance.MAX_COURSE_CLASSIFICATIONS_PER_RUN ??
    ctx.caps.MAX_COURSE_CLASSIFICATIONS_PER_RUN;
  const maxTokens =
    input.allowance.MAX_LLM_INPUT_TOKENS_PER_RUN ?? ctx.caps.MAX_LLM_INPUT_TOKENS_PER_RUN;
  const pagesBy = new Map<string, { url: string; text: string }[]>();
  for (const p of input.pages) {
    const list = pagesBy.get(p.course_id) ?? [];
    if (list.length < 2 && !list.some((x) => x.url === p.url))
      list.push({ url: p.url, text: p.text });
    pagesBy.set(p.course_id, list);
  }
  let tokens = 0;
  let stopped: BudgetHit | null = null;
  let noPages = 0;
  for (const course of courseTypeCandidates(input.courses, ctx.overrides)) {
    const pages = (pagesBy.get(course.id) ?? []).filter((p) => p.text.trim().length > 0);
    if (pages.length === 0) {
      noPages++;
      continue;
    }
    if (stopped) {
      deferred.push(course.id);
      continue;
    }
    const message = buildCourseTypeMessage(course, pages);
    const est = estimateTokens(FIXED_CHARS + message.length);
    const overCount = requests.length + 1 > maxRequests;
    const overTokens = tokens + est > maxTokens;
    if (overCount || overTokens) {
      const cap = overCount ? "MAX_COURSE_CLASSIFICATIONS_PER_RUN" : "MAX_LLM_INPUT_TOKENS_PER_RUN";
      stopped = {
        stage: "course-types",
        cap,
        limit: overCount ? maxRequests : maxTokens,
        at: ctx.now.toISOString(),
        detail: `${requests.length} courses sent`,
      };
      result.budgetHits.push(stopped);
      deferred.push(course.id);
      continue;
    }
    tokens += est;
    requests.push({
      custom_id: courseTypeCustomId(course),
      page_url: course.website ?? pages[0]!.url,
      est_input_tokens: est,
      params: {
        model: COURSE_TYPE_MODEL,
        max_tokens: COURSE_TYPE_MAX_TOKENS,
        temperature: 0,
        system: COURSE_TYPE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: message }],
        output_config: { format: OUTPUT_FORMAT },
      },
    });
  }
  if (noPages > 0)
    ctx.log.info("course-types: courses with no usable page text", { count: noPages });
  return { output: { requests, deferred }, result };
};

function answerText(r: Extract<BatchResult["result"], { type: "succeeded" }>): string {
  return r.message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export const courseTypesCollect: CourseTypesCollectStage = (ctx, input) => {
  const result = emptyResult();
  const byCustomId = new Map(input.courses.map((c) => [courseTypeCustomId(c), c]));
  const plan: UpsertPlan = { ops: [] };
  const accepted: { course_id: string; course_type: string; confidence: number }[] = [];
  const rejected: { course_id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const res of input.results) {
    const course = byCustomId.get(res.custom_id);
    if (!course || seen.has(course.id)) {
      if (!course)
        ctx.log.warn("course-types: result for an unknown course", { custom_id: res.custom_id });
      continue;
    }
    seen.add(course.id);
    const reject = (reason: string): void => {
      rejected.push({ course_id: course.id, reason });
    };
    if (res.result.type !== "succeeded") {
      reject(`batch_${res.result.type}`);
      if (res.result.type === "errored") {
        result.errors.push({
          stage: "course-types",
          kind: "llm",
          message: `${res.custom_id}: ${JSON.stringify(res.result.error).slice(0, 300)}`,
        });
      }
      continue;
    }
    const stop = res.result.message.stop_reason;
    if (stop === "refusal" || stop === "max_tokens") {
      reject(`stop_${stop}`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(answerText(res.result));
    } catch {
      reject("invalid_json");
      continue;
    }
    const answer = courseTypeAnswerSchema.safeParse(json);
    if (!answer.success) {
      reject("invalid_answer");
      continue;
    }
    const a = answer.data;
    if (a.course_type === "unknown") {
      reject("unknown");
      continue;
    }
    if (a.confidence < WEBSITE_CONFIDENCE_MIN) {
      reject("low_confidence");
      continue;
    }
    if (hasCourseTypeOverride(course, ctx.overrides)) {
      reject("override");
      continue;
    }
    if (course.course_type !== "unknown") {
      reject("already_typed");
      continue;
    }
    const confidence = Math.round(a.confidence * 1000) / 1000;
    accepted.push({ course_id: course.id, course_type: a.course_type, confidence });
    plan.ops.push({
      op: "update",
      table: "courses",
      set: {
        course_type: a.course_type,
        course_type_source: "website_llm",
        course_type_confidence: confidence,
        updated_at: ctx.now.toISOString(),
      },
      // Only a course that is still unknown: never overwrite an override or OSM type.
      where: { id: course.id, course_type: "unknown" },
    });
    ctx.log.debug("course type accepted", {
      course_id: course.id,
      course_type: a.course_type,
      confidence,
      evidence: a.evidence,
    });
  }
  return { output: { plan, accepted, rejected }, result };
};
