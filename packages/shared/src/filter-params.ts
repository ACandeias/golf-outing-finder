/**
 * zod parsing of filter query parameters (SPEC.md 9.2) for list pages and
 * /api/outings. Invalid values are dropped, never thrown, on list pages; the API
 * uses `parseFilterParamsStrict` and answers 400.
 */
import { z } from "zod";
import { isIsoDate } from "./dates.ts";
import {
  COURSE_TYPE_FILTERS,
  DISTANCE_MILES,
  FILTER_PARAMS,
  FORMAT_FILTERS,
  type CourseTypeFilter,
  type DistanceMiles,
  type ListingFilters,
} from "./filters.ts";

const MAX_PARAM_LENGTH = 200;

const courseTypeToken = z
  .string()
  .transform((v) => (v === "municipal" || v === "public" ? "municipal_public" : v))
  .pipe(z.enum(COURSE_TYPE_FILTERS));

const flag = z.enum(["1", "true", "yes", "on"]).transform(() => true);
const isoDate = z.string().refine(isIsoDate, { message: "must be YYYY-MM-DD" });
const maxPrice = z.coerce.number().int().min(0).max(25_000).transform((usd) => usd * 100);
const distance = z.coerce
  .number()
  .int()
  .refine((n): n is DistanceMiles => (DISTANCE_MILES as readonly number[]).includes(n), {
    message: "distance must be 10, 25, 50 or 100",
  })
  .transform((n) => n as DistanceMiles);
const format = z.enum(FORMAT_FILTERS);

export interface ParsedFilters {
  filters: ListingFilters;
  /** True when any filter parameter is present, valid or not (noindex rule). */
  anyFilterParam: boolean;
  /** Parameters that were present but invalid. */
  invalid: string[];
}

function values(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "" && v.length <= MAX_PARAM_LENGTH);
}

function one(params: URLSearchParams, name: string): string | null {
  const v = params.get(name);
  if (v === null) return null;
  const t = v.trim();
  return t === "" || t.length > MAX_PARAM_LENGTH ? null : t;
}

/** Parses the filter parameters of a list-page URL. */
export function parseFilterParams(params: URLSearchParams): ParsedFilters {
  const invalid: string[] = [];
  const anyFilterParam = FILTER_PARAMS.some((p) => params.has(p));

  const courseTypes: CourseTypeFilter[] = [];
  for (const raw of values(params, "course_type")) {
    const r = courseTypeToken.safeParse(raw);
    if (r.success) {
      if (!courseTypes.includes(r.data)) courseTypes.push(r.data);
    } else invalid.push("course_type");
  }

  const pick = <T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null => {
    const raw = one(params, name);
    if (raw === null) return null;
    const r = schema.safeParse(raw.toLowerCase());
    if (r.success) return r.data;
    invalid.push(name);
    return null;
  };

  let from = pick("from", isoDate);
  let to = pick("to", isoDate);
  if (from && to && from > to) [from, to] = [to, from];

  return {
    filters: {
      courseTypes,
      charityOnly: pick("charity", flag) ?? false,
      maxPriceCents: pick("max_price", maxPrice),
      from,
      to,
      distanceMiles: pick("distance", distance),
      format: pick("format", format),
      singlesWelcome: pick("singles", flag) ?? false,
    },
    anyFilterParam,
    invalid: [...new Set(invalid)],
  };
}
