import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z4 from "zod/v4";
import { z } from "zod";
import { courseTypeSchema } from "@gof/shared/schemas";

/**
 * The classifier's structured output: zod v4 for the SDK's `zodOutputFormat`
 * helper, and the zod v3 validator of record that runs again on every answer
 * before it touches the database (CLAUDE.md).
 */
export const COURSE_TYPES = [
  "municipal",
  "public",
  "semi_private",
  "private",
  "resort",
  "unknown",
] as const;

export const courseTypeAnswerSchemaV4 = z4
  .object({
    course_type: z4.enum(COURSE_TYPES),
    confidence: z4.number(),
    evidence: z4.string(),
  })
  .strict();

/** `{ type: "json_schema", schema }` without the helper's parse function, so it serializes. */
export function courseTypeOutputFormat(): { type: "json_schema"; schema: Record<string, unknown> } {
  const f = zodOutputFormat(courseTypeAnswerSchemaV4);
  const schema = structuredClone(f.schema) as Record<string, unknown> & {
    properties?: Record<string, Record<string, unknown>>;
  };
  // With zod 3.25's zod/v4 the helper turns the enum into a description; put the
  // enum back so the API constrains course_type (enums are in the supported subset).
  if (schema.properties?.course_type && !schema.properties.course_type.enum) {
    schema.properties.course_type = { type: "string", enum: [...COURSE_TYPES] };
  }
  return { type: f.type, schema };
}

export const EVIDENCE_MAX_WORDS = 20;

export const courseTypeAnswerSchema = z
  .object({
    course_type: courseTypeSchema,
    confidence: z.number().min(0).max(1),
    evidence: z
      .string()
      .max(400)
      .refine(
        (s) => s.trim().split(/\s+/).filter(Boolean).length <= EVIDENCE_MAX_WORDS,
        `evidence is ${EVIDENCE_MAX_WORDS} words or fewer`,
      ),
  })
  .strict();
export type CourseTypeAnswer = z.infer<typeof courseTypeAnswerSchema>;
