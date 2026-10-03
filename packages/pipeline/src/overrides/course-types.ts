import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { courseTypeSchema } from "@gof/shared/schemas";

/** data/overrides/course-types.yaml (SPEC.md 7.2, 8.1 step 4.1). */
const entry = z
  .object({
    osm_ref: z
      .string()
      .regex(/^(node|way|relation)\/\d+$/)
      .optional(),
    course_id: z.string().min(1).optional(),
    course_type: courseTypeSchema,
    reason: z.string().min(1),
  })
  .strict()
  .refine((e) => (e.osm_ref === undefined) !== (e.course_id === undefined), {
    message: "each override needs exactly one of osm_ref or course_id",
  });
export type CourseTypeOverride = z.infer<typeof entry>;

const file = z.object({ overrides: z.array(entry).nullable().default([]) }).passthrough();

export function parseCourseTypesYaml(text: string): CourseTypeOverride[] {
  const raw: unknown = parse(text) ?? {};
  return file.parse(raw).overrides ?? [];
}

export async function readCourseTypeOverrides(path: string): Promise<CourseTypeOverride[]> {
  return parseCourseTypesYaml(await readFile(path, "utf8"));
}

const HEADER = `# Course-type overrides. First match wins in the classifier (SPEC.md section 8.1).
# The owner edits this file; \`pnpm run seed:course-types\` added the seed entries once
# (Phase 1) and never overwrites an entry that is already here.
# Entries look like:
#   - osm_ref: way/123456          # or course_id: crs_...
#     course_type: private          # municipal | public | semi_private | private | resort | unknown
#     reason: "Member roster confirmed by owner, 2026-09-15"
`;

export function renderCourseTypesYaml(rows: readonly CourseTypeOverride[]): string {
  const body = stringify({ overrides: rows }, { lineWidth: 0 });
  return `${HEADER}${body}`;
}

const keyOf = (o: CourseTypeOverride): string => o.osm_ref ?? `id:${o.course_id ?? ""}`;

/** Adds generated entries; an entry already in the file (same key) wins and is reported. */
export function mergeCourseTypeOverrides(
  existing: readonly CourseTypeOverride[],
  generated: readonly CourseTypeOverride[],
): { merged: CourseTypeOverride[]; kept: string[] } {
  const merged = [...existing];
  const keys = new Set(existing.map(keyOf));
  const kept: string[] = [];
  for (const g of generated) {
    const k = keyOf(g);
    if (keys.has(k)) {
      kept.push(k);
      continue;
    }
    keys.add(k);
    merged.push(g);
  }
  return { merged, kept };
}
