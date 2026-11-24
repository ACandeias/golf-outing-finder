import { describe, expect, it } from "vitest";
import { migratedSqlite } from "@gof/db/testing";
import { accessItemSchema, accessRemovalSql, accessSql, buildAccessPlan, indexCourses, itemKey, itemsFromFile, type AccessItem, type AccessPlanInput } from "./load.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const TOP = [
  { name: "The Grove XXIII", state: "FL", osm_ref: "way/976384744" },
  { name: "Winged Foot Golf Club (West)", state: "NY", osm_ref: "way/122734591" },
  { name: "Pine Valley Golf Club", state: "NJ", osm_ref: null },
];
const BY_REF = new Map([
  ["way/976384744", "crs_grove"],
  ["way/122734591", "crs_wf"],
]);
const BY_NAME = new Map([["ny/maidstone club", "crs_maid"]]);
const GROVE = "https://www.32auctions.com/organizations/71786/auctions/206177/auction_items/7139828";

function item(over: Partial<AccessItem> = {}): AccessItem {
  return accessItemSchema.parse({
    course_name: "The Grove XXIII",
    course_state: "FL",
    kind: "auction",
    title: "Foursome with lunch, drinks and caddies",
    organizer: "First Tee Greater Washington DC",
    event_name: "First Tee DC 2026 auction",
    platform: "www.32auctions.com",
    link: GROVE,
    date_start: null,
    date_end: "2026-09-28",
    season: null,
    recurring: false,
    price_kind: "sold",
    price_min_usd: 14000,
    price_max_usd: null,
    players: 4,
    member_hosted: null,
    status: "closed",
    confirmed: "fetched",
    note: null,
    ...over,
  });
}

const plan = (items: AccessItem[], existingKeys: string[] = [], over: Partial<AccessPlanInput> = {}) =>
  buildAccessPlan({ items, topCourses: TOP, courseIdByOsmRef: BY_REF, courseIdByName: BY_NAME, now: NOW, existingKeys, takenSlugs: new Set(), ...over });

describe("buildAccessPlan", () => {
  it("ties an item to its course through the top-course list and publishes it", () => {
    const { rows } = plan([item()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      course_id: "crs_grove",
      kind: "auction",
      platform: "32auctions.com",
      price_kind: "sold",
      price_min_cents: 1_400_000,
      date_end: "2026-09-28",
      status: "closed",
      published: 1,
      hold_reason: null,
      slug: "auction/foursome-with-lunch-drinks-and-caddies-the-grove-xxiii",
    });
    expect(rows[0]?.id).toMatch(/^acc_[0-9A-Z]{26}$/);
  });

  it("matches a club name without the course suffix, then any course by exact name and state", () => {
    expect(plan([item({ course_name: "Winged Foot Golf Club", course_state: "NY" })]).rows[0]?.course_id).toBe("crs_wf");
    expect(plan([item({ course_name: "Maidstone Club", course_state: "NY" })]).rows[0]?.course_id).toBe("crs_maid");
  });

  it("keeps an item at an unknown course, unpublished", () => {
    const { rows } = plan([item({ course_name: "Pine Valley Golf Club", course_state: "NJ" }), item({ course_name: "Somewhere CC", link: "https://x.org/a" })]);
    expect(rows.map((r) => [r.course_id, r.published, r.hold_reason])).toEqual([
      [null, 0, "course_unmatched"],
      [null, 0, "course_unmatched"],
    ]);
  });

  it("an open item whose end date has passed is closed; recurring stays recurring", () => {
    expect(plan([item({ status: "open", price_kind: "current_bid", date_end: "2026-11-01" })]).rows[0]?.status).toBe("closed");
    expect(plan([item({ status: "open", price_kind: "current_bid", date_end: "2026-12-05" })]).rows[0]?.status).toBe("open");
    expect(plan([item({ status: "recurring", recurring: true, date_end: null, kind: "member_for_a_day" })]).rows[0]).toMatchObject({
      status: "recurring",
      recurring: 1,
    });
  });

  it("a hand-checked item keeps the day it was checked as its first-seen and last-verified day", () => {
    const { rows, upserts } = plan([item({ checked_on: "2026-11-19" }), item({ title: "Another lot" })]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      first_seen: "2026-11-19T12:00:00.000Z",
      last_verified: "2026-11-19T12:00:00.000Z",
      created_at: "2026-11-21T12:00:00.000Z",
      updated_at: "2026-11-21T12:00:00.000Z",
    });
    // Without it, the load time stands and the row is insert-only.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Another lot", first_seen: "2026-11-21T12:00:00.000Z", last_verified: "2026-11-21T12:00:00.000Z" });
    expect(accessItemSchema.safeParse({ ...item(), checked_on: "Nov 19" }).success).toBe(false);
    // A checked day after the load is a typo, not a fact.
    expect(plan([item({ checked_on: "2026-11-22" })]).upserts[0]).toMatchObject({ last_verified: "2026-11-21T12:00:00.000Z" });
  });

  it("a hand-checked item already stored is planned again, so an edit can reach the database; a researched one is skipped", () => {
    const stored = [itemKey(GROVE, "auction", "The Grove XXIII", "Foursome with lunch, drinks and caddies")];
    const checked = plan([item({ checked_on: "2026-11-20", price_min_usd: 15000 })], stored);
    expect(checked.upserts).toHaveLength(1);
    expect(checked.upserts[0]).toMatchObject({ price_min_cents: 1_500_000 });
    expect(checked.skipped).toEqual([]);
    const researched = plan([item({ price_min_usd: 15000 })], stored);
    expect(researched.rows).toEqual([]);
    expect(researched.upserts).toEqual([]);
    expect(researched.skipped).toEqual([{ link: GROVE, reason: "already stored" }]);
  });

  it("closes an open item only once its last day has ended everywhere in the US", () => {
    const lot = item({ status: "open", date_end: "2026-11-24" });
    // 00:30 UTC on Nov 25 is 7:30 PM Eastern and 2:30 PM in Honolulu on Nov 24: still the closing day.
    expect(plan([lot], [], { now: Date.parse("2026-11-25T00:30:00Z") }).rows[0]).toMatchObject({ status: "open" });
    // 10:30 UTC on Nov 25 is past midnight in Honolulu.
    expect(plan([lot], [], { now: Date.parse("2026-11-25T10:30:00Z") }).rows[0]).toMatchObject({ status: "closed" });
  });

  it("holds an item whose link was removed at an organizer's request", () => {
    const { rows } = plan([item(), item({ title: "Second lot", link: "https://example.org/kept" })], [], { removedUrls: new Set([GROVE]) });
    expect(rows[0]).toMatchObject({ published: 0, hold_reason: "removed", course_id: "crs_grove" });
    expect(rows[1]).toMatchObject({ published: 1, hold_reason: null });
  });

  it("holds a deep link to a site whose terms allow links to its home page only", () => {
    const homeOnly = (link: string) => (new URL(link).hostname.endsWith("pledgeit.org") && new URL(link).pathname !== "/" ? "PledgeIt" : null);
    const { rows } = plan(
      [
        item({ link: "https://pledgeit.org/some-auction/lot/12", platform: "pledgeit.org" }),
        item({ title: "Home page link", link: "https://pledgeit.org/", platform: "pledgeit.org" }),
      ],
      [],
      { homePageOnly: homeOnly },
    );
    expect(rows[0]).toMatchObject({ published: 0, hold_reason: "needs_review" });
    expect(rows[1]).toMatchObject({ published: 1, hold_reason: null });
  });

  it("skips repeats within a load and items already stored; catalog lots sharing a link stay apart", () => {
    const stored = itemKey(GROVE, "auction", "The Grove XXIII", "Foursome with lunch, drinks and caddies");
    expect(plan([item()], [stored]).skipped.map((s) => s.reason)).toEqual(["already stored"]);
    expect(plan([item(), item()]).skipped.map((s) => s.reason)).toEqual(["repeated in this load"]);
    const catalog = "https://e.givesmart.com/events/Nkt/i/_All/";
    expect(plan([item({ link: catalog }), item({ link: catalog, title: "Golf and lunch for 3" })]).rows).toHaveLength(2);
  });

  it("refuses non-http links, bad dates and over-long titles at parse time", () => {
    expect(() => item({ link: "javascript:alert(1)" })).toThrow();
    expect(() => item({ date_end: "Sept 2026" })).toThrow();
    expect(() => item({ title: "x".repeat(200) })).toThrow();
  });
});

describe("itemsFromFile", () => {
  it("reads the research runner's files", () => {
    const items = itemsFromFile({ club: { club: "X" }, opportunities: [item()], queries_run: [] });
    expect(items).toHaveLength(1);
  });

  it("converts the first-round agent files: lots to auctions, listings to their kind", () => {
    const items = itemsFromFile({
      lots: [
        {
          club: "The Grove XXIII",
          state: "FL",
          title: "Foursome",
          players: 4,
          member_hosted: null,
          includes: [],
          organizer: "First Tee DC",
          auction_name: null,
          platform: "32auctions.com",
          close_date: "2026-09-28",
          price_kind: "sold",
          price_usd: 14000,
          value_usd: null,
          status: "closed",
          url: GROVE,
          confirmed: "fetched",
        },
      ],
      listings: [
        { club: "Maidstone Club", state: "NY", kind: "outing", title: "Charity outing", organizer: null, date: "2026-06-01", platform: "x.org", url: "https://x.org/o", confirmed: "snippet" },
      ],
    });
    expect(items.map((i) => [i.kind, i.course_name, i.date_end ?? i.date_start, i.price_min_usd])).toEqual([
      ["auction", "The Grove XXIII", "2026-09-28", 14000],
      ["outing", "Maidstone Club", "2026-06-01", null],
    ]);
  });

  it("drops an entry that doesn't validate instead of failing the whole file", () => {
    const items = itemsFromFile({ opportunities: [item(), { ...item(), link: "not a url" }] });
    expect(items).toHaveLength(1);
  });
});

describe("indexCourses", () => {
  it("looks courses up by OSM ref, and by name only when the name is unique in its state", () => {
    const { byRef, byName } = indexCourses([
      { id: "c1", name: "Maidstone Club", state: "NY", osm_ref: "way/1" },
      { id: "c2", name: "Riverside Golf Course", state: "NY", osm_ref: null },
      { id: "c3", name: "Riverside Golf Course", state: "NY", osm_ref: "way/3" },
      { id: "c4", name: "Riverside Golf Course", state: "CA", osm_ref: null },
    ]);
    expect([...byRef]).toEqual([
      ["way/1", "c1"],
      ["way/3", "c3"],
    ]);
    expect([...byName]).toEqual([
      ["ny/maidstone club", "c1"],
      ["ca/riverside golf course", "c4"],
    ]);
  });
});

describe("access SQL against the real schema", () => {
  const COURSE = `INSERT INTO courses (id, slug, name, city, state, lat, lng, time_zone, course_type, notable, outing_count, created_at, updated_at, aliases)
    VALUES ('crs_grove', 'fl/the-grove-xxiii', 'The Grove XXIII', 'Hobe Sound', 'FL', 27.0, -80.1, 'America/New_York', 'private', 1, 0, 'x', 'x', '[]'),
      ('crs_maid', 'ny/maidstone-club', 'Maidstone Club', 'East Hampton', 'NY', 40.9, -72.2, 'America/New_York', 'private', 1, 0, 'x', 'x', '[]');`;
  type Stored = { id: string; slug: string; status: string; date_end: string | null; price_kind: string | null; price_min_cents: number | null; published: number; hold_reason: string | null; first_seen: string; last_verified: string };
  const read = (db: ReturnType<typeof migratedSqlite>) =>
    db.prepare("SELECT id, slug, status, date_end, price_kind, price_min_cents, published, hold_reason, first_seen, last_verified FROM access_opportunities ORDER BY title").all() as Stored[];
  const keysOf = (db: ReturnType<typeof migratedSqlite>) =>
    (db.prepare("SELECT link, kind, course_name, title, slug FROM access_opportunities").all() as { link: string; kind: string; course_name: string; title: string; slug: string }[]);
  const load = (db: ReturnType<typeof migratedSqlite>, items: AccessItem[], now: number, over: Partial<AccessPlanInput> = {}) => {
    const stored = keysOf(db);
    const p = buildAccessPlan({
      items,
      topCourses: TOP,
      courseIdByOsmRef: BY_REF,
      courseIdByName: BY_NAME,
      now,
      existingKeys: stored.map((e) => itemKey(e.link, e.kind, e.course_name, e.title)),
      takenSlugs: new Set(stored.map((e) => e.slug)),
      ...over,
    });
    db.exec(accessSql(p).join("\n"));
    return p;
  };
  const open = (over: Partial<AccessItem> = {}) =>
    item({ status: "open", date_end: "2026-11-24", price_kind: "current_bid", price_min_usd: 2200, checked_on: "2026-11-23", title: "Round for 3 with a member, O'Brien's charity", ...over });

  it("an edit to a hand-checked entry reaches the stored row, which keeps its id, slug and first-seen day", () => {
    const db = migratedSqlite();
    db.exec(COURSE);
    load(db, [open()], Date.parse("2026-11-23T20:00:00Z"));
    const before = read(db);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: "open", price_kind: "current_bid", price_min_cents: 220_000, published: 1, last_verified: "2026-11-23T12:00:00.000Z" });

    // The lot closed; the owner types in what it sold for and the day they checked.
    load(db, [open({ status: "closed", price_kind: "sold", price_min_usd: 3100, checked_on: "2026-11-25" })], Date.parse("2026-11-25T20:00:00Z"));
    const after = read(db);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before[0]!.id,
      slug: before[0]!.slug,
      first_seen: before[0]!.first_seen,
      status: "closed",
      price_kind: "sold",
      price_min_cents: 310_000,
      last_verified: "2026-11-25T12:00:00.000Z",
    });
  });

  it("an older copy of the catalog never overwrites a newer check, and researched rows are never rewritten", () => {
    const db = migratedSqlite();
    db.exec(COURSE);
    load(db, [open({ checked_on: "2026-11-25", price_min_usd: 3100 }), item({ title: "Researched lot" })], Date.parse("2026-11-25T20:00:00Z"));
    load(db, [open({ checked_on: "2026-11-23", price_min_usd: 2200 }), item({ title: "Researched lot", price_min_usd: 1 })], Date.parse("2026-11-26T20:00:00Z"));
    const rows = read(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.price_min_cents).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([310_000, 1_400_000]);
  });

  it("a removal request unpublishes stored rows on that link, and a reload doesn't bring them back", () => {
    const db = migratedSqlite();
    db.exec(COURSE);
    const now = Date.parse("2026-11-23T20:00:00Z");
    load(db, [open(), open({ title: "Another club on the same page", course_name: "Maidstone Club", course_state: "NY" }), item({ title: "Kept", link: "https://example.org/kept" })], now);
    expect(read(db).map((r) => r.published)).toEqual([1, 1, 1]);
    const removed = new Set([GROVE]);
    db.exec(accessRemovalSql(removed, now).join("\n"));
    load(db, [open({ checked_on: "2026-11-24" })], Date.parse("2026-11-24T20:00:00Z"), { removedUrls: removed });
    const rows = db.prepare("SELECT title, published, hold_reason FROM access_opportunities ORDER BY title").all();
    expect(rows).toEqual([
      { title: "Another club on the same page", published: 0, hold_reason: "removed" },
      { title: "Kept", published: 1, hold_reason: null },
      { title: "Round for 3 with a member, O'Brien's charity", published: 0, hold_reason: "removed" },
    ]);
    expect(accessRemovalSql(new Set(), now)).toEqual([]);
  });
});
