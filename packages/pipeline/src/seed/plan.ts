import { createHash } from "node:crypto";
import { ulid } from "@gof/shared/ids";
import { orgTypeForOutingType } from "@gof/shared/labels";
import { dollarsToCents, formatUsd } from "@gof/shared/money";
import type { OutingType } from "@gof/shared/schemas";
import { organizerSlug, outingSlug } from "@gof/shared/slug";
import type { CourseRecord } from "../courses/import.ts";
import { matchCourse, type MatchResult } from "../match/match-course.ts";
import type { PlaceLocator } from "../places/locator.ts";
import { isTestEntry, type SeedEntry, type SeedFile } from "./seed-file.ts";

/**
 * Seed loader core (SPEC.md 13 Phase 1), pure: seed entries plus imported courses
 * in, table rows out. The CLI in ../seed.ts reads the files and writes the SQL.
 */

export interface OrganizerRecord {
  id: string;
  slug: string;
  name: string;
  orgType: ReturnType<typeof orgTypeForOutingType>;
  ein: null;
  charityStatus: "unverified";
  irsSubsection: null;
  website: null;
  seriesId: null;
  createdAt: string;
  updatedAt: string;
}

export interface OutingRecord {
  id: string;
  slug: string;
  courseId: string;
  organizerId: string | null;
  title: string;
  summary: string | null;
  outingType: OutingType;
  audience: "open" | "aimed_at_group";
  audienceNote: string | null;
  startDate: string | null;
  endDate: string | null;
  shotgunTime: string | null;
  format: "scramble" | "best_ball" | "shamble" | "stroke" | "other" | null;
  singlePriceCents: number | null;
  foursomePriceCents: number | null;
  sponsorOnly: 0 | 1;
  includes: string;
  handicapRequired: 0 | 1 | null;
  status: "open" | "expected";
  expectedMonth: string | null;
  registrationUrl: string | null;
  canonicalSourceUrl: string;
  sourceGone: 0;
  confidence: number;
  published: 0 | 1;
  holdReason: "no_date" | "removed" | null;
  expectedMisses: 0;
  nextOutingId: null;
  firstSeen: string;
  lastVerified: string;
  updatedAt: string;
}

export type SourceKind = "organizer" | "platform" | "directory" | "association";

export interface SourceRecord {
  id: string;
  url: string;
  domain: string;
  kind: SourceKind;
}

export interface SeedMatch {
  seedId: string;
  outingId: string;
  courseId: string;
  courseName: string;
  score: number;
  facility: boolean;
}

export interface SeedPlan {
  courses: CourseRecord[];
  organizers: OrganizerRecord[];
  outings: OutingRecord[];
  sources: SourceRecord[];
  sourceOutings: { sourceId: string; outingId: string }[];
  matches: SeedMatch[];
  skipped: string[];
}

export interface Removals {
  outing_ids: readonly string[];
  urls: readonly string[];
}

export interface SeedPlanInput {
  seed: SeedFile;
  courses: readonly CourseRecord[];
  locator: PlaceLocator;
  now: number;
  includeTestEntries: boolean;
  /** data/overrides/registration-hosts.yaml (amendment A5). */
  registrationHosts: readonly string[];
  /** data/overrides/removals.yaml. */
  removals: Removals;
}

export interface UnmatchedEntry {
  seedId: string;
  courseName: string;
  city: string;
  state: string;
  result: MatchResult<CourseRecord>["kind"];
  candidates: string[];
}

export class SeedMatchError extends Error {
  readonly unmatched: UnmatchedEntry[];
  constructor(unmatched: UnmatchedEntry[]) {
    const lines = unmatched.map(
      (u) =>
        `  ${u.seedId}: "${u.courseName}", ${u.city}, ${u.state} -> ${u.result}` +
        (u.candidates.length > 0 ? ` (candidates: ${u.candidates.join("; ")})` : ""),
    );
    super(`${unmatched.length} seed entr${unmatched.length === 1 ? "y does" : "ies do"} not match a course:\n${lines.join("\n")}`);
    this.name = "SeedMatchError";
    this.unmatched = unmatched;
  }
}

function stableId(prefix: string, now: number, key: string): string {
  const bytes = createHash("sha256").update(`${prefix}:${key}`).digest();
  return `${prefix}_${ulid(now, bytes.subarray(0, 10))}`;
}

/** Registrable domain without a public-suffix list: the last two labels (US sites). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  return labels.slice(-2).join(".");
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function domainOf(url: string): string {
  return hostOf(url).replace(/^www\./, "");
}

/**
 * Amendment A5: keep `registration_url` when its registrable domain equals the
 * page's, or its host (or a parent) is on the registration-host allowlist.
 */
export function allowedRegistrationUrl(
  registrationUrl: string | null | undefined,
  pageUrl: string,
  hosts: readonly string[],
): string | null {
  if (!registrationUrl) return null;
  let reg: URL;
  try {
    reg = new URL(registrationUrl);
  } catch {
    return null;
  }
  if (reg.protocol !== "https:" && reg.protocol !== "http:") return null;
  const host = reg.hostname.toLowerCase();
  if (registrableDomain(host) === registrableDomain(hostOf(pageUrl))) return reg.toString();
  for (const h of hosts) {
    const allowed = h.toLowerCase();
    if (host === allowed || host.endsWith(`.${allowed}`)) return reg.toString();
  }
  return null;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "Monday, March 15, 2027" in a synthetic fixture -> 2027-03-15. */
function dateFromText(text: string | undefined): string | null {
  const m = text ? new RegExp(`(${MONTHS.join("|")})\\s+(\\d{1,2}),\\s+(\\d{4})`).exec(text) : null;
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] as (typeof MONTHS)[number]) + 1;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

function time12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const suffix = h < 12 ? "a.m." : "p.m.";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const FORMAT_WORDS: Readonly<Record<string, string>> = {
  scramble: "Scramble",
  best_ball: "Best-ball event",
  shamble: "Shamble",
  stroke: "Stroke-play event",
  other: "Golf outing",
};

/** A factual summary built from structured fields, never from organizer text. */
function summarize(o: OutingRecord, course: CourseRecord): string {
  const where = `${course.name}${course.city ? ` in ${course.city}` : ""}, ${course.state}`;
  const what = o.format ? (FORMAT_WORDS[o.format] ?? "Golf outing") : "Golf outing";
  const parts: string[] = [];
  if (o.status === "expected") {
    parts.push(
      o.startDate
        ? `${what} at ${where}, announced for ${longDate(o.startDate)}.`
        : o.expectedMonth
          ? `${what} at ${where}, expected in ${monthName(o.expectedMonth)}.`
          : `${what} at ${where}; the next date has not been announced.`,
    );
  } else if (o.startDate) {
    const span = o.endDate && o.endDate !== o.startDate ? ` through ${longDate(o.endDate)}` : "";
    const start = o.shotgunTime ? ` with a ${time12(o.shotgunTime)} start` : "";
    parts.push(`${what} at ${where} on ${longDate(o.startDate)}${span}${start}.`);
  }
  const prices: string[] = [];
  if (o.singlePriceCents !== null) prices.push(`${formatUsd(o.singlePriceCents)} per player`);
  if (o.foursomePriceCents !== null) prices.push(`${formatUsd(o.foursomePriceCents)} per foursome`);
  if (prices.length > 0) parts.push(`Entry is ${prices.join(", ")}.`);
  else if (o.sponsorOnly) parts.push("Foursomes are sold through sponsor packages.");
  if (o.audienceNote) parts.push(`${o.audienceNote}.`);
  const text = parts.join(" ");
  return text.length <= 300 ? text : `${text.slice(0, 297).replace(/\s+\S*$/, "")}...`;
}

/** Builds every row the seed loads. Throws SeedMatchError listing every unmatched entry. */
export function buildSeedPlan(input: SeedPlanInput): SeedPlan {
  const nowIso = new Date(input.now).toISOString();
  const courses = input.courses.map((c) => ({ ...c, aliases: [...c.aliases] }));
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const entries: SeedEntry[] = [];
  const skipped: string[] = [];
  for (const e of input.seed.outings) {
    if (isTestEntry(e) && !input.includeTestEntries) skipped.push(e.id);
    else entries.push(e);
  }

  // Match every entry first so all failures are reported together.
  const unmatched: UnmatchedEntry[] = [];
  const matched = new Map<string, { course: CourseRecord; score: number; facility: boolean }>();
  for (const e of entries) {
    const r = matchCourse({ name: e.course_name, state: e.course_state, city: e.course_city }, courses, {
      cityCentroid: input.locator.cityCentroid(e.course_state, e.course_city),
    });
    if (r.kind !== "matched") {
      unmatched.push({
        seedId: e.id,
        courseName: e.course_name,
        city: e.course_city,
        state: e.course_state,
        result: r.kind,
        candidates: r.candidates.map((c) => `${c.course.name} (${c.course.city ?? "?"}, ${c.score.toFixed(3)})`),
      });
      continue;
    }
    const course = courseById.get(r.course.id);
    if (!course) throw new Error(`matched course ${r.course.id} is not in the import`);
    for (const alias of r.aliasesToAdd) if (!course.aliases.includes(alias)) course.aliases.push(alias);
    matched.set(e.id, { course, score: r.score, facility: r.facility });
  }
  if (unmatched.length > 0) throw new SeedMatchError(unmatched);

  const organizers: OrganizerRecord[] = [];
  const organizerByName = new Map<string, OrganizerRecord>();
  const organizerSlugs = new Set<string>();
  const outings: OutingRecord[] = [];
  const outingSlugs = new Set<string>();
  const sources: SourceRecord[] = [];
  const sourceByUrl = new Map<string, SourceRecord>();
  const links: { sourceId: string; outingId: string }[] = [];
  const linkKeys = new Set<string>();
  const matches: SeedMatch[] = [];
  const removedIds = new Set(input.removals.outing_ids);
  const removedUrls = new Set(input.removals.urls);
  const regHosts = input.registrationHosts.map((h) => h.toLowerCase());

  const addSource = (url: string, kind: SourceKind, outingId: string): void => {
    let s = sourceByUrl.get(url);
    if (!s) {
      s = { id: stableId("src", input.now, url), url, domain: domainOf(url), kind };
      sourceByUrl.set(url, s);
      sources.push(s);
    }
    const key = `${s.id}|${outingId}`;
    if (!linkKeys.has(key)) {
      linkKeys.add(key);
      links.push({ sourceId: s.id, outingId });
    }
  };

  for (const e of entries) {
    const m = matched.get(e.id);
    if (!m) continue;
    const outingType: OutingType = e.expected_outing_type ?? "other";

    let organizerId: string | null = null;
    const orgName = e.organizer_name?.trim();
    if (orgName) {
      const key = orgName.toLowerCase();
      let org = organizerByName.get(key);
      if (!org) {
        const slug = organizerSlug(orgName, organizerSlugs);
        organizerSlugs.add(slug);
        org = {
          id: stableId("org", input.now, key),
          slug,
          name: orgName,
          orgType: orgTypeForOutingType(outingType),
          ein: null,
          charityStatus: "unverified",
          irsSubsection: null,
          website: null,
          seriesId: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        organizerByName.set(key, org);
        organizers.push(org);
      }
      organizerId = org.id;
    }

    const expected = e.status === "expected";
    const startDate = expected
      ? (e.announced_date ?? null)
      : (e.start_date ?? (e.status === "synthetic" ? dateFromText(e.fixture_text) : null));
    if (!expected && !startDate) throw new Error(`seed entry ${e.id} has no start_date`);
    const expectedMonth = expected ? (e.expected_month ?? null) : null;
    const year = Number(
      (startDate ?? expectedMonth ?? e.last_date ?? nowIso).slice(0, 4),
    );

    // A synthetic test entry has no page; it gets a reserved .invalid URL (RFC 2606).
    const sourceUrl =
      e.source_url ?? e.event_url ?? (e.status === "synthetic" ? `https://seed.invalid/synthetic/${e.id}` : undefined);
    if (!sourceUrl) throw new Error(`seed entry ${e.id} has no source_url`);
    // A directory index (the Scramble Hunter home page) is never canonical; its event page is.
    const canonical = e.source_kind === "directory" && e.event_url ? e.event_url : sourceUrl;
    const registrationUrl = allowedRegistrationUrl(e.registration_url, canonical, regHosts);

    const id = stableId("out", input.now, e.id);
    const slug = outingSlug(year, e.title, m.course.name, outingSlugs);
    outingSlugs.add(slug);

    let published: 0 | 1 = 1;
    let holdReason: OutingRecord["holdReason"] = null;
    if (expected && !expectedMonth) {
      published = 0;
      holdReason = "no_date";
    }
    if (e.status === "excluded") published = 0;
    const urls = [e.source_url, e.event_url, e.registration_url, canonical].filter(
      (u): u is string => typeof u === "string",
    );
    if (removedIds.has(e.id) || removedIds.has(id) || urls.some((u) => removedUrls.has(u))) {
      published = 0;
      holdReason = "removed";
    }

    const outing: OutingRecord = {
      id,
      slug,
      courseId: m.course.id,
      organizerId,
      title: e.title,
      summary: null,
      outingType,
      audience: e.audience ?? "open",
      audienceNote: e.audience_note ?? null,
      startDate,
      endDate: expected ? null : (e.end_date ?? null),
      shotgunTime: expected ? null : (e.shotgun_time ?? null),
      format: e.format ?? null,
      singlePriceCents: e.single_price_usd == null ? null : dollarsToCents(e.single_price_usd),
      foursomePriceCents: e.foursome_price_usd == null ? null : dollarsToCents(e.foursome_price_usd),
      sponsorOnly: e.sponsor_only ? 1 : 0,
      includes: "[]",
      handicapRequired: null,
      status: expected ? "expected" : "open",
      expectedMonth,
      registrationUrl,
      canonicalSourceUrl: canonical,
      sourceGone: 0,
      confidence: 1,
      published,
      holdReason,
      expectedMisses: 0,
      nextOutingId: null,
      firstSeen: nowIso,
      lastVerified: nowIso,
      updatedAt: nowIso,
    };
    outing.summary = summarize(outing, m.course);
    outings.push(outing);
    matches.push({
      seedId: e.id,
      outingId: id,
      courseId: m.course.id,
      courseName: m.course.name,
      score: m.score,
      facility: m.facility,
    });

    const kind: SourceKind = e.source_kind ?? "organizer";
    if (e.source_url) addSource(e.source_url, kind, id);
    if (e.event_url) addSource(e.event_url, e.source_kind ?? "directory", id);
    if (e.registration_url) {
      const regHost = hostOf(e.registration_url);
      const onPlatform = regHosts.some((h) => regHost === h || regHost.endsWith(`.${h}`));
      addSource(e.registration_url, onPlatform ? "platform" : kind, id);
    }
  }

  // outing_count is all-time published outings; last_outing_date the latest date among them.
  for (const c of courses) {
    const mine = outings.filter((o) => o.courseId === c.id && o.published === 1);
    c.outingCount = mine.length;
    const dates = mine.map((o) => o.startDate).filter((d): d is string => d !== null).sort();
    c.lastOutingDate = dates.at(-1) ?? null;
  }

  return { courses, organizers, outings, sources, sourceOutings: links, matches, skipped };
}
