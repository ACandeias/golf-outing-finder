import { z } from "zod";
import { kebab } from "@gof/shared/slug";
import { seedEntrySchema, type SeedEntry } from "../seed/seed-file.ts";

/**
 * Hand research (web search results confirmed on organizer pages) to seed
 * entries for data/top-course-outings.json. Pure. Rejects what the site can't
 * publish honestly: past one-off dates, expected rows with no month, and
 * outings whose only source is a platform whose terms ban automated access
 * (SPEC.md 8.2).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullish = <T extends z.ZodType>(t: T) => t.nullable().optional();

export const researchItemSchema = z.object({
  course_name: z.string().min(1),
  course_city: z.string().min(1),
  course_state: z.string().regex(/^[A-Z]{2}$/),
  title: z.string().min(1),
  organizer_name: nullish(z.string()),
  beneficiary: nullish(z.string()),
  outing_type: z
    .enum(["charity", "school_fundraiser", "business_association", "open_tournament", "other"])
    .default("charity"),
  status: z.enum(["open", "expected"]),
  start_date: nullish(isoDate),
  end_date: nullish(isoDate),
  last_date: nullish(isoDate),
  expected_month: nullish(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)),
  shotgun_time: nullish(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
  format: nullish(z.enum(["scramble", "best_ball", "shamble", "stroke", "other"])),
  single_price_usd: nullish(z.number().min(0)),
  foursome_price_usd: nullish(z.number().min(0)),
  sponsor_only: z.boolean().default(false),
  audience: z.enum(["open", "aimed_at_group"]).default("open"),
  audience_note: nullish(z.string()),
  source_url: z.string().url(),
  registration_url: nullish(z.string().url()),
  only_on_denied_platform: z.boolean().default(false),
  evidence: z.string().default(""),
});
export type ResearchItem = z.infer<typeof researchItemSchema>;

export interface ConvertResult {
  entries: SeedEntry[];
  rejected: { title: string; course: string; reason: string }[];
}

const PRICE_CAP_USD = 25_000;

/** Drops a leading "28th Annual" so titles stay stable from year to year. */
export function stableTitle(title: string): string {
  return title
    .replace(/^\s*(the\s+)?\d+(st|nd|rd|th)\s+annual\s+/i, (_m, the: string | undefined) => (the ? "The " : ""))
    .replace(/^\s*annual\s+/i, "")
    .trim();
}

export function convertResearch(
  items: readonly ResearchItem[],
  opts: { today: string; existing: readonly SeedEntry[]; prefix?: string },
): ConvertResult {
  const prefix = opts.prefix ?? "t";
  const entries: SeedEntry[] = [];
  const rejected: ConvertResult["rejected"] = [];
  const seenUrls = new Set(opts.existing.flatMap((e) => [e.source_url, e.event_url]).filter(Boolean));
  const seenKeys = new Set(opts.existing.map((e) => `${e.course_state}|${kebab(e.title)}`));
  // Seed ids are "<letter><two digits>-<slug>"; numbers roll over to the next letter after 99.
  const usedCodes = new Set(opts.existing.map((e) => e.id.slice(0, 3)));
  let letter = prefix.charCodeAt(0);
  let n = 0;
  const nextCode = (): string => {
    for (;;) {
      n += 1;
      if (n > 99) {
        n = 1;
        letter += 1;
        if (letter > "z".charCodeAt(0)) throw new Error("ran out of seed id prefixes");
      }
      const code = `${String.fromCharCode(letter)}${String(n).padStart(2, "0")}`;
      if (!usedCodes.has(code)) {
        usedCodes.add(code);
        return code;
      }
    }
  };

  for (const it of items) {
    const reject = (reason: string): void => {
      rejected.push({ title: it.title, course: `${it.course_name}, ${it.course_state}`, reason });
    };
    if (it.only_on_denied_platform) {
      reject("only source is a platform whose terms ban automated access");
      continue;
    }
    if (it.status === "open" && (!it.start_date || it.start_date < opts.today)) {
      reject(it.start_date ? `date ${it.start_date} is past` : "open with no date");
      continue;
    }
    if (it.status === "expected" && !it.expected_month) {
      reject("expected with no month");
      continue;
    }
    if (it.status === "expected" && it.expected_month && it.expected_month < opts.today.slice(0, 7)) {
      reject(`expected month ${it.expected_month} is past`);
      continue;
    }
    const title = stableTitle(it.title);
    const key = `${it.course_state}|${kebab(title)}`;
    if (seenUrls.has(it.source_url) || seenKeys.has(key)) {
      reject("duplicate of an entry already in the file");
      continue;
    }
    seenUrls.add(it.source_url);
    seenKeys.add(key);

    const id = `${nextCode()}-${kebab(`${title} ${it.course_name}`).slice(0, 48).replace(/-+$/, "")}`;

    const cap = (v: number | null | undefined): number | null => (v == null || v > PRICE_CAP_USD ? null : v);
    const evidence =
      it.evidence +
      ([it.single_price_usd, it.foursome_price_usd].some((v) => v != null && v > PRICE_CAP_USD)
        ? " A price above the $25,000 schema cap was left out."
        : "");
    entries.push(
      seedEntrySchema.parse({
        id,
        status: it.status,
        title,
        organizer_name: it.organizer_name ?? null,
        beneficiary: it.beneficiary ?? null,
        course_name: it.course_name,
        course_city: it.course_city,
        course_state: it.course_state,
        start_date: it.status === "open" ? it.start_date : null,
        end_date: it.status === "open" ? (it.end_date ?? null) : null,
        last_date: it.last_date ?? null,
        expected_month: it.status === "expected" ? it.expected_month : null,
        shotgun_time: it.status === "open" ? (it.shotgun_time ?? null) : null,
        format: it.format ?? null,
        single_price_usd: cap(it.single_price_usd),
        foursome_price_usd: cap(it.foursome_price_usd),
        sponsor_only: it.sponsor_only,
        audience: it.audience,
        ...(it.audience_note ? { audience_note: it.audience_note } : {}),
        source_url: it.source_url,
        registration_url: it.registration_url ?? null,
        source_kind: "organizer",
        expected_outing_type: it.outing_type,
        evidence: evidence.trim(),
      }),
    );
  }
  return { entries, rejected };
}
