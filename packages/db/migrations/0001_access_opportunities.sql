-- Access opportunities: every way a non-member can get onto a course besides a
-- dated outing row: charity auction lots, member-for-a-day programs, resort and
-- stay-and-play bookings, public tee times, qualifiers, pro-ams that sell spots,
-- charity dinners with a round, fundraiser packages, and outings found by
-- research. A course outside `courses` is kept by name (course_id NULL).
-- docs/plans/auction-lots.md; owner approved 2026-11-21. No ranks (SPEC.md 7.1).
CREATE TABLE access_opportunities (
  id TEXT PRIMARY KEY,                       -- 'acc_' + ULID
  slug TEXT NOT NULL UNIQUE,
  course_id TEXT REFERENCES courses(id),
  course_name TEXT NOT NULL,                 -- as researched
  course_state TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('outing', 'auction', 'member_for_a_day', 'stay_and_play', 'resort_booking',
    'public_tee_time', 'qualifier', 'pro_am', 'charity_dinner', 'fundraiser_package', 'other')),
  title TEXT NOT NULL CHECK (length(title) <= 160),   -- our words
  organizer_name TEXT,
  event_name TEXT,                           -- 'ForeBatten 2026', 'First Tee DC 2026 auction'
  platform TEXT NOT NULL,                    -- registrable domain the listing lives on
  link TEXT NOT NULL,
  date_start TEXT,                           -- YYYY-MM-DD
  date_end TEXT,                             -- YYYY-MM-DD; an auction's close date
  season TEXT,                               -- 'May to Oct', 'annual, September'
  recurring INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1)),
  price_kind TEXT CHECK (price_kind IS NULL OR price_kind IN
    ('entry_fee', 'green_fee', 'package', 'current_bid', 'starting_bid', 'buy_now', 'sold', 'donation')),
  price_min_cents INTEGER CHECK (price_min_cents IS NULL OR price_min_cents >= 0),
  price_max_cents INTEGER CHECK (price_max_cents IS NULL OR price_max_cents >= 0),
  players INTEGER CHECK (players IS NULL OR players BETWEEN 1 AND 8),
  member_hosted INTEGER CHECK (member_hosted IS NULL OR member_hosted IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('open', 'upcoming', 'closed', 'recurring', 'unknown')),
  confirmed TEXT NOT NULL CHECK (confirmed IN ('fetched', 'snippet')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  hold_reason TEXT CHECK (hold_reason IS NULL OR hold_reason IN ('needs_review', 'course_unmatched', 'removed')),
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX access_opportunities_item ON access_opportunities(link, kind, course_name, title);
CREATE INDEX access_opportunities_course ON access_opportunities(course_id, kind);
CREATE INDEX access_opportunities_listed ON access_opportunities(published, status, date_end);
CREATE INDEX access_opportunities_platform ON access_opportunities(platform);
