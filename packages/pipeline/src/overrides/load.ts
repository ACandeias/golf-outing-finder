import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { metroSchema, type Metro } from "../places/files.ts";
import { parseCourseTypesYaml, type CourseTypeOverride } from "./course-types.ts";

/**
 * zod-validated readers for every owner-edited file in data/overrides (SPEC.md
 * 7.2) and the generated data/places/metros.yaml. Parsers take YAML text and are
 * pure; `loadOverrides` reads the files once at the edge and the result goes into
 * the stage Context.
 */

export const OVERRIDE_FILES = {
  courseTypes: "course-types.yaml",
  exclusions: "exclusions.yaml",
  removals: "removals.yaml",
  notableCourses: "notable-courses.yaml",
  series: "series.yaml",
  accessOperators: "access-operators.yaml",
  tournamentOperators: "tournament-operators.yaml",
  jsPlatforms: "js-platforms.yaml",
  registrationHosts: "registration-hosts.yaml",
} as const;
export type OverrideFile = keyof typeof OVERRIDE_FILES;

function yamlObject(text: string, file: string): unknown {
  const v: unknown = parse(text) ?? {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${file}: expected a YAML mapping at the top level`);
  }
  return v;
}

function withFile<T>(file: string, schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${file}: ${issues}`);
  }
  return r.data;
}

/** A bare, lowercase host or registrable domain: `golfwithaccess.com`, `support.kidney.org`. */
export const hostNameSchema = z
  .string()
  .min(1)
  .transform((h) => h.trim().toLowerCase())
  .pipe(z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/, "must be a bare host name like example.com"));

const listOf = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().default([]).transform((v) => v ?? []);

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http or https URL");

// exclusions.yaml -------------------------------------------------------------

/**
 * `url_patterns` are globs over the full normalized URL: `*` matches any run of
 * characters, everything else is literal. `https://example.org/events/*` excludes
 * every page under /events/.
 */
const exclusionsSchema = z
  .object({ domains: listOf(hostNameSchema), url_patterns: listOf(z.string().min(1)) })
  .strict();
export type Exclusions = z.infer<typeof exclusionsSchema>;

export function parseExclusionsYaml(text: string): Exclusions {
  return withFile(OVERRIDE_FILES.exclusions, exclusionsSchema, yamlObject(text, OVERRIDE_FILES.exclusions));
}

// removals.yaml ---------------------------------------------------------------

const removalsSchema = z.object({ outing_ids: listOf(z.string().min(1)), urls: listOf(httpUrl) }).strict();
export type Removals = z.infer<typeof removalsSchema>;

export function parseRemovalsYaml(text: string): Removals {
  return withFile(OVERRIDE_FILES.removals, removalsSchema, yamlObject(text, OVERRIDE_FILES.removals));
}

// notable-courses.yaml --------------------------------------------------------

const OSM_REF = /^(node|way|relation)\/\d+$/;
const notableEntry = z.union([
  z.string().min(1),
  z
    .object({ name: z.string().min(1).optional(), osm_ref: z.string().regex(OSM_REF).optional() })
    .strict()
    .refine((e) => e.name !== undefined || e.osm_ref !== undefined, "needs name or osm_ref"),
]);
const notableSchema = z.object({ courses: listOf(notableEntry) }).strict();
export interface NotableCourses {
  names: string[];
  osmRefs: string[];
}

export function parseNotableCoursesYaml(text: string): NotableCourses {
  const f = withFile(OVERRIDE_FILES.notableCourses, notableSchema, yamlObject(text, OVERRIDE_FILES.notableCourses));
  const names: string[] = [];
  const osmRefs: string[] = [];
  for (const e of f.courses) {
    if (typeof e === "string") {
      if (OSM_REF.test(e)) osmRefs.push(e);
      else names.push(e);
    } else {
      if (e.name) names.push(e.name);
      if (e.osm_ref) osmRefs.push(e.osm_ref);
    }
  }
  return { names, osmRefs };
}

// series.yaml -----------------------------------------------------------------

export const seriesEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case id"),
    name: z.string().min(1),
    index_url: httpUrl,
  })
  .strict();
export type SeriesEntry = z.infer<typeof seriesEntrySchema>;
const seriesSchema = z
  .object({ series: listOf(seriesEntrySchema) })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const s of f.series) {
      if (seen.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate series id ${s.id}` });
      seen.add(s.id);
    }
  });

export function parseSeriesYaml(text: string): SeriesEntry[] {
  return withFile(OVERRIDE_FILES.series, seriesSchema, yamlObject(text, OVERRIDE_FILES.series)).series;
}

// access-operators, tournament-operators (domains); js-platforms, registration-hosts (hosts)

const domainsSchema = z.object({ domains: listOf(hostNameSchema) }).strict();
const hostsSchema = z.object({ hosts: listOf(hostNameSchema) }).strict();

export function parseDomainsYaml(text: string, file: string): string[] {
  return withFile(file, domainsSchema, yamlObject(text, file)).domains;
}

export function parseHostsYaml(text: string, file: string): string[] {
  return withFile(file, hostsSchema, yamlObject(text, file)).hosts;
}

// metros.yaml -----------------------------------------------------------------

const metrosSchema = z.object({ metros: z.array(metroSchema) }).strict();

export function parseMetrosYaml(text: string): Metro[] {
  return withFile("metros.yaml", metrosSchema, yamlObject(text, "metros.yaml")).metros;
}

// All of them -----------------------------------------------------------------

export interface Overrides {
  courseTypes: readonly CourseTypeOverride[];
  exclusions: Readonly<Exclusions>;
  removals: Readonly<Removals>;
  notableCourses: Readonly<NotableCourses>;
  series: readonly SeriesEntry[];
  accessOperators: readonly string[];
  tournamentOperators: readonly string[];
  jsPlatforms: readonly string[];
  registrationHosts: readonly string[];
  metros: readonly Metro[];
}

export type OverrideTexts = Record<OverrideFile, string> & { metros: string };

/** Parses every file's text. Throws naming the file and the bad entry. */
export function parseOverrides(texts: OverrideTexts): Overrides {
  return deepFreeze({
    courseTypes: parseCourseTypesYaml(texts.courseTypes),
    exclusions: parseExclusionsYaml(texts.exclusions),
    removals: parseRemovalsYaml(texts.removals),
    notableCourses: parseNotableCoursesYaml(texts.notableCourses),
    series: parseSeriesYaml(texts.series),
    accessOperators: parseDomainsYaml(texts.accessOperators, OVERRIDE_FILES.accessOperators),
    tournamentOperators: parseDomainsYaml(texts.tournamentOperators, OVERRIDE_FILES.tournamentOperators),
    jsPlatforms: parseHostsYaml(texts.jsPlatforms, OVERRIDE_FILES.jsPlatforms),
    registrationHosts: parseHostsYaml(texts.registrationHosts, OVERRIDE_FILES.registrationHosts),
    metros: parseMetrosYaml(texts.metros),
  });
}

/** Reads data/overrides/*.yaml and data/places/metros.yaml. */
export async function loadOverrides(dirs: { overrides: string; places: string }): Promise<Overrides> {
  const entries = await Promise.all(
    (Object.keys(OVERRIDE_FILES) as OverrideFile[]).map(
      async (k) => [k, await readFile(join(dirs.overrides, OVERRIDE_FILES[k]), "utf8")] as const,
    ),
  );
  const texts = Object.fromEntries(entries) as Record<OverrideFile, string>;
  const metros = await readFile(join(dirs.places, "metros.yaml"), "utf8");
  return parseOverrides({ ...texts, metros });
}

/** An empty set of overrides, for tests that build their own. */
export function emptyOverrides(patch: Partial<Overrides> = {}): Overrides {
  return deepFreeze({
    courseTypes: [],
    exclusions: { domains: [], url_patterns: [] },
    removals: { outing_ids: [], urls: [] },
    notableCourses: { names: [], osmRefs: [] },
    series: [],
    accessOperators: [],
    tournamentOperators: [],
    jsPlatforms: [],
    registrationHosts: [],
    metros: [],
    ...patch,
  });
}

// Helpers the stages share ----------------------------------------------------

/** True when `host` is `entry` or a subdomain of it. */
export function hostMatches(host: string, entries: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return entries.some((e) => h === e || h.endsWith(`.${e}`));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** exclusions.yaml: the URL's host is a listed domain (or under one), or a pattern matches. */
export function isExcludedUrl(url: string, exclusions: Exclusions): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (hostMatches(host, exclusions.domains)) return true;
  return exclusions.url_patterns.some((p) => globToRegExp(p).test(url));
}

/** removals.yaml: an outing is removed by id, or when any of its URLs is listed. */
export function isRemoved(outingId: string, urls: readonly string[], removals: Removals): boolean {
  if (removals.outing_ids.includes(outingId)) return true;
  return urls.some((u) => removals.urls.includes(u));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
