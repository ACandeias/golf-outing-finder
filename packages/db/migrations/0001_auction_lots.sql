-- Auction lots: a round or foursome at a named club that a charity, school or
-- hospital auctions off (docs/plans/auction-lots.md). A separate listing kind
-- from outings: no date of play, a close date and a bid instead of a price.
CREATE TABLE auction_lots (
  id TEXT PRIMARY KEY,                       -- 'lot_' + ULID
  slug TEXT NOT NULL UNIQUE,                 -- '2026/foursome-the-grove-xxiii-first-tee-dc'
  course_id TEXT NOT NULL REFERENCES courses(id),
  organizer_id TEXT REFERENCES organizers(id),
  organizer_name TEXT,                       -- as the auction page names it
  auction_name TEXT,                         -- 'ForeBatten 2026'
  title TEXT NOT NULL,                       -- our words
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 300),
  players INTEGER CHECK (players IS NULL OR players BETWEEN 1 AND 8),
  member_hosted INTEGER CHECK (member_hosted IS NULL OR member_hosted IN (0, 1)),
  includes TEXT NOT NULL DEFAULT '[]',       -- JSON array
  platform TEXT NOT NULL,                    -- registrable domain: '32auctions.com'
  closes_at TEXT,                            -- YYYY-MM-DD, or ISO 8601 with offset
  price_kind TEXT CHECK (price_kind IS NULL OR price_kind IN ('current_bid', 'starting_bid', 'buy_now', 'sold')),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  value_cents INTEGER CHECK (value_cents IS NULL OR value_cents >= 0),
  price_checked_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'open', 'closed', 'sold', 'withdrawn', 'unknown')),
  lot_url TEXT NOT NULL,                     -- the lot, or the auction catalog when lots have no page of their own
  confirmed TEXT NOT NULL CHECK (confirmed IN ('fetched', 'snippet')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  hold_reason TEXT CHECK (hold_reason IS NULL OR hold_reason IN
    ('needs_review', 'platform_not_allowed', 'course_unmatched', 'no_close_date', 'closed', 'removed')),
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX auction_lots_lot ON auction_lots(lot_url, course_id, title);
CREATE INDEX auction_lots_course ON auction_lots(course_id, closes_at);
CREATE INDEX auction_lots_listed ON auction_lots(published, status, closes_at);
