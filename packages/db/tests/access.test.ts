import { beforeAll, describe, expect, it } from "vitest";
import { accessForCourse, accessPage, courseHasAccess, featuredAccess, orderAccess } from "../src/access.ts";
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
    const o = (id: string, status: string, end: string | null) => ({ id, status, dateEnd: end, dateStart: null });
    expect(
      ids(orderAccess([o("c1", "closed", "2026-03-18"), o("r", "recurring", null), o("c2", "closed", "2026-09-28"), o("u", "upcoming", "2027-05-01"), o("p", "open", "2026-12-05")], TODAY)),
    ).toEqual(["p", "u", "r", "c2", "c1"]);
  });

  it("a course's published items, with the course attached", async () => {
    const items = await accessForCourse(db, "crs_top", TODAY);
    expect(ids(items)).toEqual(["a_open", "o_upcoming", "m_recurring", "a_closed_new", "a_closed_old"]);
    expect(items[0]).toMatchObject({ kind: "auction", priceKind: "sold", priceMinCents: 1400000, course: { slug: "fl/the-grove-xxiii", notable: true } });
    expect(await accessForCourse(db, "crs_none", TODAY)).toEqual([]);
  });

  it("featured: courses on the top-course list only, open and recurring first", async () => {
    expect(ids(await featuredAccess(db, TODAY, 3))).toEqual(["a_open", "o_upcoming", "m_recurring"]);
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
