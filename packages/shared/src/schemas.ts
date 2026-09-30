import { z } from "zod";

export const courseTypeSchema = z.enum([
  "municipal",
  "public",
  "semi_private",
  "private",
  "resort",
  "unknown",
]);
export type CourseType = z.infer<typeof courseTypeSchema>;

export const outingStatusSchema = z.enum([
  "open",
  "waitlist",
  "sold_out",
  "cancelled",
  "past",
  "expected",
]);
export type OutingStatus = z.infer<typeof outingStatusSchema>;

export const outingTypeSchema = z.enum([
  "charity",
  "school_fundraiser",
  "business_association",
  "access_day",
  "open_tournament",
  "pro_am",
  "other",
]);
export type OutingType = z.infer<typeof outingTypeSchema>;

export const audienceSchema = z.enum(["open", "aimed_at_group"]);
export type Audience = z.infer<typeof audienceSchema>;

export const formatSchema = z.enum(["scramble", "best_ball", "shamble", "stroke", "other"]);
export type OutingFormat = z.infer<typeof formatSchema>;

export const includesItemSchema = z.enum([
  "lunch",
  "breakfast",
  "dinner",
  "cart",
  "caddie",
  "range",
  "gift",
  "contests",
]);
export type IncludesItem = z.infer<typeof includesItemSchema>;

// Extraction output schema, matching SPEC.md section 8.4.
export const extractionSchema = z.object({
  is_outing: z.boolean(),
  reject_reason: z
    .enum(["not_golf", "past", "members_only", "resort_package", "qualifier", "no_date", "other"])
    .nullable(),
  title: z.string(),
  organizer_name: z.string().nullable(),
  organizer_ein: z.string().nullable(),
  beneficiary: z.string().nullable(),
  course_name: z.string().nullable(),
  venue_address: z.string().nullable(),
  venue_city: z.string().nullable(),
  venue_state: z.string().length(2).nullable(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  shotgun_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  format: formatSchema.nullable(),
  single_price_usd: z.number().min(0).max(25000).nullable(),
  foursome_price_usd: z.number().min(0).max(25000).nullable(),
  sponsor_only: z.boolean(),
  includes: z.array(includesItemSchema),
  handicap_required: z.boolean().nullable(),
  status: z.enum(["open", "waitlist", "sold_out", "cancelled", "unknown"]),
  registration_url: z.string().url().nullable(),
  outing_type_hint: outingTypeSchema,
  audience: audienceSchema,
  audience_note: z.string().nullable(),
  lodging_required: z.boolean(),
  summary: z.string().max(300),
  evidence: z.object({
    date: z.string().nullable(),
    price: z.string().nullable(),
    venue: z.string().nullable(),
  }),
});
export type Extraction = z.infer<typeof extractionSchema>;
