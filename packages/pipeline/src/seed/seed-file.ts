import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  audienceSchema,
  courseTypeSchema,
  formatSchema,
  outingTypeSchema,
} from "@gof/shared/schemas";

/** seed/outings.json (SPEC.md 11). Every field the loader reads is validated. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const seedEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z]\d{2}-[a-z0-9-]+$/),
    golden_case: z.string().nullable().optional(),
    status: z.enum(["open", "excluded", "expected", "synthetic"]),
    title: z.string().min(1),
    organizer_name: z.string().min(1).nullable().optional(),
    course_name: z.string().min(1),
    course_city: z.string().min(1),
    course_state: z.string().regex(/^[A-Z]{2}$/),
    course_address: z.string().optional(),
    start_date: isoDate.nullable().optional(),
    end_date: isoDate.nullable().optional(),
    shotgun_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    format: formatSchema.nullable().optional(),
    single_price_usd: z.number().min(0).max(25_000).nullable().optional(),
    foursome_price_usd: z.number().min(0).max(25_000).nullable().optional(),
    sponsor_only: z.boolean().optional(),
    audience: audienceSchema.optional(),
    audience_note: z.string().optional(),
    source_url: z.string().url().optional(),
    event_url: z.string().url().optional(),
    registration_url: z.string().url().nullable().optional(),
    source_kind: z.enum(["organizer", "platform", "directory", "association"]).optional(),
    render_required: z.boolean().optional(),
    expected_course_type: courseTypeSchema.optional(),
    expected_outing_type: outingTypeSchema.optional(),
    expected_display_label: z.string().optional(),
    last_date: isoDate.nullable().optional(),
    expected_month: yearMonth.nullable().optional(),
    announced_date: isoDate.optional(),
    fixture_text: z.string().optional(),
  })
  .passthrough();
export type SeedEntry = z.infer<typeof seedEntrySchema>;

export const seedFileSchema = z
  .object({
    version: z.string(),
    outings: z.array(seedEntrySchema).min(1),
  })
  .passthrough()
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    for (const e of f.outings) {
      if (ids.has(e.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate seed id ${e.id}` });
      ids.add(e.id);
    }
  });
export type SeedFile = z.infer<typeof seedFileSchema>;

export async function readSeedFile(path: string): Promise<SeedFile> {
  return seedFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export const isTestEntry = (e: SeedEntry): boolean => e.status === "synthetic" || e.status === "excluded";
