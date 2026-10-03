-- Initial schema for Golf Outing Finder (SPEC.md v1.1, section 7.1).
-- Generated from the section 7.1 SQL block; packages/db/src/schema.ts mirrors it and
-- packages/db/tests/migration.test.ts checks the two agree.
-- Apply with: wrangler d1 migrations apply gof --local | --remote

CREATE TABLE series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  index_url TEXT NOT NULL
);

CREATE TABLE cities (
  id INTEGER PRIMARY KEY,                  -- GeoNames geonameid
  slug TEXT NOT NULL,                      -- kebab(name)
  name TEXT NOT NULL,
  state TEXT NOT NULL,                     -- two-letter USPS code
  lat REAL NOT NULL, lng REAL NOT NULL,
  population INTEGER NOT NULL DEFAULT 0,
  time_zone TEXT NOT NULL
);
CREATE UNIQUE INDEX cities_state_slug ON cities(state, slug);
CREATE INDEX cities_geo ON cities(lat, lng);

CREATE TABLE zips (
  zip TEXT PRIMARY KEY CHECK (length(zip) = 5),
  lat REAL NOT NULL, lng REAL NOT NULL,
  city_id INTEGER REFERENCES cities(id)
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,                     -- 'crs_' + ULID
  slug TEXT NOT NULL UNIQUE,               -- 'ny/winged-foot-golf-club'
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',      -- JSON array
  street TEXT,
  city TEXT,                               -- OSM addr:city, else the nearest city within 30 km
  state TEXT NOT NULL CHECK (length(state) = 2),
  zip TEXT,
  lat REAL NOT NULL, lng REAL NOT NULL,
  time_zone TEXT NOT NULL,                 -- IANA, e.g. 'America/New_York'
  course_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (course_type IN ('municipal','public','semi_private','private','resort','unknown')),
  course_type_source TEXT
    CHECK (course_type_source IS NULL OR course_type_source IN ('override','osm','website_llm')),
  course_type_confidence REAL
    CHECK (course_type_confidence IS NULL OR course_type_confidence BETWEEN 0 AND 1),
  notable INTEGER NOT NULL DEFAULT 0 CHECK (notable IN (0,1)), -- never store or show rankings
  website TEXT,
  osm_ref TEXT UNIQUE,                     -- 'way/123456'
  outing_count INTEGER NOT NULL DEFAULT 0 CHECK (outing_count >= 0), -- all-time published outings
  last_outing_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX courses_geo ON courses(lat, lng);
CREATE INDEX courses_state_city ON courses(state, city);

CREATE TABLE organizers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,               -- kebab(name), '-2' on collision
  name TEXT NOT NULL,
  org_type TEXT NOT NULL CHECK (org_type IN
    ('charity','school','business_association','access_operator','tournament_operator','other')),
  ein TEXT,
  charity_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (charity_status IN ('501c3','other_nonprofit','not_nonprofit','unverified')),
  irs_subsection TEXT,                     -- e.g. '03', '06'
  website TEXT,
  series_id TEXT REFERENCES series(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,               -- '2026/nkf-golf-classic-winged-foot', '-2' on collision
  course_id TEXT NOT NULL REFERENCES courses(id),
  organizer_id TEXT REFERENCES organizers(id),
  title TEXT NOT NULL,
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 300), -- our words
  outing_type TEXT NOT NULL CHECK (outing_type IN
    ('charity','school_fundraiser','business_association','access_day','open_tournament','pro_am','other')),
  audience TEXT NOT NULL DEFAULT 'open' CHECK (audience IN ('open','aimed_at_group')),
  audience_note TEXT,                      -- 'Aimed at Fordham alumni'
  start_date TEXT,                         -- YYYY-MM-DD; NULL only when status = 'expected';
                                           -- an expected row may carry an announced date
  end_date TEXT,
  shotgun_time TEXT,                       -- 'HH:MM', course local time
  format TEXT CHECK (format IS NULL OR format IN ('scramble','best_ball','shamble','stroke','other')),
  single_price_cents INTEGER CHECK (single_price_cents IS NULL OR single_price_cents BETWEEN 0 AND 2500000),
  foursome_price_cents INTEGER CHECK (foursome_price_cents IS NULL OR foursome_price_cents BETWEEN 0 AND 2500000),
  sponsor_only INTEGER NOT NULL DEFAULT 0 CHECK (sponsor_only IN (0,1)), -- foursomes sold only inside sponsor packages
  includes TEXT NOT NULL DEFAULT '[]',     -- JSON: lunch, breakfast, dinner, cart, caddie, range, gift, contests
  handicap_required INTEGER CHECK (handicap_required IS NULL OR handicap_required IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('open','waitlist','sold_out','cancelled','past','expected')),
  expected_month TEXT,                     -- 'YYYY-MM' when status = 'expected'
  registration_url TEXT,
  canonical_source_url TEXT NOT NULL,
  source_gone INTEGER NOT NULL DEFAULT 0 CHECK (source_gone IN (0,1)),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  hold_reason TEXT CHECK (hold_reason IS NULL OR hold_reason IN
    ('course_unmatched','low_confidence','status_unknown','no_date','expected_stale','removed')),
  expected_misses INTEGER NOT NULL DEFAULT 0 CHECK (expected_misses BETWEEN 0 AND 2), -- section 8.9
  next_outing_id TEXT REFERENCES outings(id),
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_date IS NOT NULL OR status = 'expected'),
  CHECK (end_date IS NULL OR (start_date IS NOT NULL AND end_date >= start_date))
);
CREATE INDEX outings_listing ON outings(published, status, start_date);
CREATE INDEX outings_course ON outings(course_id, start_date);
CREATE INDEX outings_organizer ON outings(organizer_id);
-- Expression index: SQLite treats NULLs as distinct, so a plain index on organizer_id
-- would never catch two organizer-less rows on the same course and date.
CREATE UNIQUE INDEX outings_dedupe ON outings(course_id, start_date, COALESCE(organizer_id, ''))
  WHERE start_date IS NOT NULL;
-- One expected row per course, organizer and month.
CREATE UNIQUE INDEX outings_expected ON outings(course_id, organizer_id, expected_month)
  WHERE status = 'expected';

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organizer','platform','directory','association','series','submission','search')),
  fetched_at TEXT,
  http_status INTEGER,
  consecutive_gone INTEGER NOT NULL DEFAULT 0, -- consecutive 404/410 responses
  content_hash TEXT,
  extracted_json TEXT,                     -- the last { "events": [...] } result, kept for held events
  extractor_version TEXT,
  hold_reason TEXT CHECK (hold_reason IS NULL OR hold_reason IN
    ('course_unmatched','low_confidence','status_unknown','no_date','expected_stale','removed')),
  held_until TEXT,                         -- keep waiting for a second source until this date
  error TEXT
);
CREATE INDEX sources_hold ON sources(hold_reason) WHERE hold_reason IS NOT NULL;

-- One page can describe many outings (an association calendar, a series index),
-- and one outing can have many sources.
CREATE TABLE source_outings (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, outing_id)
);
CREATE INDEX source_outings_outing ON source_outings(outing_id);

CREATE TABLE discovery_queue (
  url TEXT PRIMARY KEY,
  found_via TEXT NOT NULL,
  found_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  created_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0,1))
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('nightly','monthly')),
  started_at TEXT NOT NULL,                -- written when the run starts
  finished_at TEXT,
  stages_done TEXT NOT NULL DEFAULT '[]',  -- JSON; updated after every stage
  serp_queries INTEGER NOT NULL DEFAULT 0,
  fetches INTEGER NOT NULL DEFAULT 0,
  renders INTEGER NOT NULL DEFAULT 0,
  extractions INTEGER NOT NULL DEFAULT 0,
  course_classifications INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens INTEGER NOT NULL DEFAULT 0,
  pending_batch_id TEXT,                   -- the only place a pending batch id is stored
  outings_new INTEGER NOT NULL DEFAULT 0,
  outings_updated INTEGER NOT NULL DEFAULT 0,
  outings_held INTEGER NOT NULL DEFAULT 0,
  budget_hits TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  est_cost_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX runs_started ON runs(started_at);
