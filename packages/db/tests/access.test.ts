import { beforeAll, describe, expect, it } from "vitest";
import { accessForCourse, accessPage, actByDate, courseHasAccess, featuredAccess, lastDay, liveStatus, orderAccess } from "../src/access.ts";
import type { GofDb } from "../src/queries.ts";
import { drizzleOver, migratedSqlite } from "../src/testing.ts";

const T = "2026-11-21T12:00:00.000Z";
const TODAY = "2026-11-21";
const row = (id: string, course: string | null, kind: string, status: string, end: string | null, published = 1, title = id) =>
  `('${id}', 'x/${id}', ${course ? `'${course}'` : "NULL"}, 'Club ${id}', 'NY', '${kind}', '${title}', 'Org', NULL, '32auctions.com',
    'https://example.org/${id}', NULL, ${end ? `'${end}'` : "NULL"}, NULL, ${status === "recurring" ? 1 : 0}, 'sold', 1400000, NULL, 4, NULL,
    '${status}', 'fetched', ${published}, ${published ? "NULL" : "'course_unmatched'"}, '${T}', '${T}', '${T}', '${T}')`;

const FIXTURE = `
INSERT INTO courses (id, slug, name, city, state, lat, lng, time_zone, course_type, notable, outing_count, created_at, updated_at, aliases) VALUES
  ('crs_top', 'fl/the-grove-xxiii', 'The Grove XXIII', 'Hobe Sound', 'FL', 27.0, -80.1, 'America/New_York', 'private', 1, 0, '${T}', '${T}', '[]'),
  ('crs_plain', 'ny/plain-cc', 'Plain CC', 'Rye', 'NY', 41.0, -73.7, 'America/New_York', 'private', 0, 0, '${T}', '${T}', '[]'),
  ('crs_none', 'ny/none-cc', 'None CC', 'Rye', 'NY', 41.0, -73.7, 'America/New_York', 'private', 1, 0, '${T}', '${T}', '[]');
INSERT INTO access_opportunities (id, slug, course_id, course_name, course_state, kind, title, organizer_name, event_name, platform,
  link, date_start, date_end, season, recurring, price_kind, price_min_cents, price_max_cents, players, member_hosted,
  status, confirmed, published, hold_reason, first_seen, last_verified, created_at, updated_at) VALUES
  ${[
    row("a_closed_old", "crs_top", "auction", "closed", "2026-03-18"),
    row("a_closed_new", "crs_top", "auction", "closed", "2026-09-28"),
    row("a_open", "crs_top", "auction", "open", "2026-12-05"),
    row("m_recurring", "crs_top", "member_for_a_day", "recurring", null),
    row("o_upcoming", "crs_top", "outing", "upcoming", "2027-05-01"),
    row("p_plain", "crs_plain", "auction", "open", "2026-12-01"),
    row("u_unmatched", null, "auction", "open", "2026-12-01", 0),
    row("h_held", "crs_none", "auction", "open", "2026-12-01", 0),
  ].join(",\n  ")};
`;

let db: GofDb;
beforeAll(() => {
  const sqlite = migratedSqlite();
  sqlite.exec(FIXTURE);
  db = drizzleOver(sqlite);
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("access opportunities", () => {
  it("orders open and upcoming first (soonest), then recurring, then closed (most recent first)", () => {
    const o = (id: string, status: string, end: string | null) => ({ id, kind: "auction", status, dateEnd: end, dateStart: null });
    expect(
      ids(orderAccess([o("c1", "closed", "2026-03-18"), o("r", "recurring", null), o("c2", "closed", "2026-09-28"), o("u", "upcoming", "2027-05-01"), o("p", "open", "2026-12-05")], TODAY)),
    ).toEqual(["p", "u", "r", "c2", "c1"]);
  });

  it("orders by the day to act by: an event's first day, an auction's closing day", () => {
    const multiDay = { id: "event", kind: "outing", status: "open", dateStart: "2026-12-31", dateEnd: "2027-01-03" };
    const lot = { id: "lot", kind: "auction", status: "open", dateStart: "2026-11-01", dateEnd: "2027-01-02" };
    const offer = { id: "offer", kind: "stay_and_play", status: "open", dateStart: "2026-04-01", dateEnd: "2027-03-31" };
    expect(ids(orderAccess([offer, lot, multiDay], TODAY))).toEqual(["event", "lot", "offer"]);
  });

  it("open and upcoming interleave by act-by day; undated live items come after dated ones", () => {
    const o = (id: string, kind: string, status: string, dateStart: string | null, dateEnd: string | null) => ({ id, kind, status, dateStart, dateEnd });
    const items = [
      o("offer-march", "stay_and_play", "open", "2026-04-01", "2027-03-31"),
      o("tee-times", "public_tee_time", "open", null, null),
      o("outing-soon", "outing", "upcoming", "2026-11-24", null),
      o("lot-no-close", "auction", "open", "2026-11-01", null),
      o("lot-dec", "auction", "open", null, "2026-12-05"),
    ];
    expect(ids(orderAccess(items, TODAY))).toEqual(["outing-soon", "lot-dec", "offer-march", "lot-no-close", "tee-times"]);
  });

  it("closed lots sort by whichever date they carry, most recent first", () => {
    const c = (id: string, dateStart: string | null, dateEnd: string | null) => ({ id, kind: "auction", status: "closed", dateStart, dateEnd });
    expect(ids(orderAccess([c("end-march", null, "2026-03-18"), c("start-only-june", "2026-06-01", null), c("undated", null, null)], TODAY))).toEqual([
      "start-only-june",
      "end-march",
      "undated",
    ]);
  });

  it("act-by date: closing day for an auction, first day for an event, last day for an offer", () => {
    expect(actByDate({ kind: "auction", dateStart: "2026-11-01", dateEnd: "2026-11-24" })).toBe("2026-11-24");
    // A lot's start date is when bidding opens (or the day of the round), never a closing day.
    expect(actByDate({ kind: "auction", dateStart: "2026-11-01", dateEnd: null })).toBeNull();
    expect(actByDate({ kind: "outing", dateStart: "2026-12-31", dateEnd: "2027-01-03" })).toBe("2026-12-31");
    expect(actByDate({ kind: "pro_am", dateStart: null, dateEnd: "2027-05-26" })).toBe("2027-05-26");
    expect(actByDate({ kind: "stay_and_play", dateStart: "2026-04-01", dateEnd: "2027-03-31" })).toBe("2027-03-31");
    expect(actByDate({ kind: "public_tee_time", dateStart: null, dateEnd: null })).toBeNull();
  });

  it("last day: an auction with no closing date never ends on its own", () => {
    expect(lastDay({ kind: "auction", dateStart: "2026-11-01", dateEnd: null })).toBeNull();
    expect(lastDay({ kind: "auction", dateStart: null, dateEnd: "2026-11-24" })).toBe("2026-11-24");
    expect(lastDay({ kind: "outing", dateStart: "2026-12-31", dateEnd: "2027-01-03" })).toBe("2027-01-03");
    expect(lastDay({ kind: "outing", dateStart: "2026-12-31", dateEnd: null })).toBe("2026-12-31");
  });

  it("live status: open and upcoming items close the day after their last day", () => {
    const lot = { kind: "auction", status: "open" as const, dateStart: null, dateEnd: "2026-11-24" };
    expect(liveStatus(lot, "2026-11-24")).toBe("open");
    expect(liveStatus(lot, "2026-11-25")).toBe("closed");
    expect(liveStatus({ ...lot, status: "upcoming" as const }, "2026-11-25")).toBe("closed");
    // An event under way is still open until its last day has passed.
    const event = { kind: "outing", status: "open" as const, dateStart: "2026-12-31", dateEnd: "2027-01-03" };
    expect(liveStatus(event, "2027-01-02")).toBe("open");
    expect(liveStatus(event, "2027-01-04")).toBe("closed");
    // Stored statuses that aren't open or upcoming are never changed, and no date means no change.
    expect(liveStatus({ ...lot, status: "recurring" as const }, "2027-06-01")).toBe("recurring");
    expect(liveStatus({ kind: "auction", status: "open" as const, dateStart: "2026-11-01", dateEnd: null }, "2027-06-01")).toBe("open");
  });

  it("with a local day, each item's status is as of its own course's day", async () => {
    // The list day is still Dec 5, but it is already Dec 6 in New York, where both courses are.
    const eastAhead = (tz: string) => (tz === "America/New_York" ? "2026-12-06" : "2026-12-05");
    const items = await accessForCourse(db, "crs_top", "2026-12-05", eastAhead);
    expect(items.find((i) => i.id === "a_open")).toMatchObject({ status: "closed", localToday: "2026-12-06", course: { timeZone: "America/New_York" } });
    // Without one, the list day stands and the item carries it.
    expect((await accessForCourse(db, "crs_top", "2026-12-05"))[0]).toMatchObject({ id: "a_open", status: "open", localToday: "2026-12-05" });
    expect((await accessPage(db, "2026-12-05", eastAhead)).find((i) => i.id === "p_plain")?.status).toBe("closed");
    expect((await featuredAccess(db, "2026-12-05", 9, undefined, eastAhead)).find((i) => i.id === "a_open")?.status).toBe("closed");
  });

  it("a stored open lot reads as closed once its closing day has passed", async () => {
    const items = await accessForCourse(db, "crs_top", "2026-12-06");
    expect(items.find((i) => i.id === "a_open")?.status).toBe("closed");
    expect(ids(items)).toEqual(["o_upcoming", "m_recurring", "a_open", "a_closed_new", "a_closed_old"]);
    // The same row is still open on its closing day.
    expect((await accessForCourse(db, "crs_top", "2026-12-05"))[0]).toMatchObject({ id: "a_open", status: "open" });
  });

  it("a course's published items, with the course attached", async () => {
    const items = await accessForCourse(db, "crs_top", TODAY);
    expect(ids(items)).toEqual(["a_open", "o_upcoming", "m_recurring", "a_closed_new", "a_closed_old"]);
    expect(items[0]).toMatchObject({ kind: "auction", priceKind: "sold", priceMinCents: 1400000, course: { slug: "fl/the-grove-xxiii", notable: true } });
    expect(await accessForCourse(db, "crs_none", TODAY)).toEqual([]);
  });

  it("featured: courses on the top-course list only, open and recurring first", async () => {
    expect(ids(await featuredAccess(db, TODAY, 3))).toEqual(["a_open", "o_upcoming", "m_recurring"]);
    // The home page's course-type default (no municipal) applies too.
    expect(await featuredAccess(db, TODAY, 3, ["municipal"])).toEqual([]);
  });

  it("the full page: every published item at a matched course", async () => {
    expect(ids(await accessPage(db, TODAY)).sort()).toEqual(
      ["a_closed_new", "a_closed_old", "a_open", "m_recurring", "o_upcoming", "p_plain"].sort(),
    );
  });

  it("knows which courses have a published item", async () => {
    expect(await courseHasAccess(db, "crs_top")).toBe(true);
    expect(await courseHasAccess(db, "crs_none")).toBe(false);
  });
});
