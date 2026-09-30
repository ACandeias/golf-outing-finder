-- Initial schema. Mirrors packages/db/src/schema.ts and SPEC.md section 7.1.
-- Apply with: wrangler d1 migrations apply <db-name>

CREATE TABLE series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  index_url TEXT NOT NULL
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  street TEXT,
  city TEXT,
  state TEXT NOT NULL,
  zip TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  time_zone TEXT NOT NULL,
  course_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (course_type IN ('municipal','public','semi_private','private','resort','unknown')),
  course_type_source TEXT,
  course_type_confidence REAL,
  notable INTEGER NOT NULL DEFAULT 0,
  website TEXT,
  osm_ref TEXT UNIQUE,
  outing_count INTEGER NOT NULL DEFAULT 0,
  last_outing_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX courses_geo ON courses(lat, lng);
CREATE INDEX courses_state_city ON courses(state, city);

CREATE TABLE organizers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  org_type TEXT NOT NULL CHECK (org_type IN
    ('charity','school','business_association','access_operator','tournament_operator','other')),
  ein TEXT,
  charity_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (charity_status IN ('501c3','other_nonprofit','not_nonprofit','unverified')),
  irs_subsection TEXT,
  website TEXT,
  series_id TEXT REFERENCES series(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  course_id TEXT NOT NULL REFERENCES courses(id),
  organizer_id TEXT REFERENCES organizers(id),
  title TEXT NOT NULL,
  summary TEXT,
  outing_type TEXT NOT NULL CHECK (outing_type IN
    ('charity','school_fundraiser','business_association','access_day','open_tournament','pro_am','other')),
  audience TEXT NOT NULL DEFAULT 'open' CHECK (audience IN ('open','aimed_at_group')),
  audience_note TEXT,
  start_date TEXT,
  end_date TEXT,
  shotgun_time TEXT,
  format TEXT,
  single_price_cents INTEGER,
  foursome_price_cents INTEGER,
  sponsor_only INTEGER NOT NULL DEFAULT 0,
  includes TEXT NOT NULL DEFAULT '[]',
  handicap_required INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','waitlist','sold_out','cancelled','past','expected')),
  expected_month TEXT,
  registration_url TEXT,
  canonical_source_url TEXT NOT NULL,
  source_gone INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT,
  next_outing_id TEXT REFERENCES outings(id),
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outings_listing ON outings(published, status, start_date);
CREATE INDEX outings_course ON outings(course_id, start_date);
CREATE UNIQUE INDEX outings_dedupe ON outings(course_id, start_date, organizer_id)
  WHERE start_date IS NOT NULL;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  outing_id TEXT REFERENCES outings(id),
  url TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('organizer','platform','directory','association','series','submission','search')),
  fetched_at TEXT,
  http_status INTEGER,
  content_hash TEXT,
  extracted_json TEXT,
  extractor_version TEXT,
  error TEXT
);

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
  url TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  serp_queries INTEGER NOT NULL DEFAULT 0,
  fetches INTEGER NOT NULL DEFAULT 0,
  renders INTEGER NOT NULL DEFAULT 0,
  extractions INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens INTEGER NOT NULL DEFAULT 0,
  pending_batch_id TEXT,
  outings_new INTEGER NOT NULL DEFAULT 0,
  outings_updated INTEGER NOT NULL DEFAULT 0,
  outings_held INTEGER NOT NULL DEFAULT 0,
  budget_hits TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  est_cost_cents INTEGER NOT NULL DEFAULT 0
);
