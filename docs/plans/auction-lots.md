# Plan: charity auction lots for rounds at top clubs

Status: **draft for the owner's review (2026-11-21). No pipeline code until it's approved.**

## What it is

A second listing kind, separate from outings. An auction lot is a round or a foursome at a named club that a charity, school or hospital is auctioning off: "Foursome at The Grove XXIII with a member", "Round for three at Pine Valley". We list the lot, say who runs the auction and when it closes, show the current bid or starting price, and link to the lot. We don't run auctions, take bids or handle money.

It starts with The Grove XXIII (Hobe Sound, FL; `way/976384744`, now on `data/top-courses.json` and typed private in `course-types.yaml`) and the private clubs on the top-course list.

Why a separate kind: an outing is an event anyone can pay to enter on a known date. A lot is a bid on a future round, usually member-hosted and booked later. It has no date of play, price or registration, so it doesn't fit the `outings` columns, publish rules or Event JSON-LD.

## Data model (one new migration, `0001_auction_lots.sql`)

```sql
CREATE TABLE auction_lots (
  id TEXT PRIMARY KEY,                       -- 'lot_' + ULID
  slug TEXT NOT NULL UNIQUE,                 -- '2027/foursome-the-grove-xxiii-st-marys-gala'
  course_id TEXT NOT NULL REFERENCES courses(id),
  organizer_id TEXT REFERENCES organizers(id),       -- the charity, school or hospital
  auction_name TEXT,                         -- "St. Mary's Spring Gala 2027"
  title TEXT NOT NULL,                       -- our words
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 300),  -- our words: players, host, extras
  players INTEGER CHECK (players IS NULL OR players BETWEEN 1 AND 8),
  member_hosted INTEGER CHECK (member_hosted IN (0, 1)),   -- NULL when the page doesn't say
  includes TEXT NOT NULL DEFAULT '[]',       -- JSON array: ["lunch", "caddies", "overnight"]
  platform TEXT NOT NULL,                    -- platforms.yaml name, or 'organizer_site'
  opens_at TEXT,                             -- ISO 8601 with offset, when the page gives one
  closes_at TEXT,                            -- ISO 8601 with offset; required to publish
  price_kind TEXT CHECK (price_kind IN ('current_bid', 'starting_bid', 'buy_now', 'sold')),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  value_cents INTEGER,                       -- the organizer's stated value, when shown
  price_checked_at TEXT NOT NULL,            -- bids move: shown as "as of"
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'open', 'closed', 'sold', 'withdrawn')),
  lot_url TEXT NOT NULL UNIQUE,              -- normalized; the link we send people to
  published INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT CHECK (hold_reason IS NULL OR hold_reason IN
    ('needs_review', 'platform_not_allowed', 'course_unmatched', 'no_close_date', 'closed', 'removed')),
  confidence REAL NOT NULL,
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX auction_lots_course ON auction_lots(course_id, closes_at);
CREATE INDEX auction_lots_listed ON auction_lots(published, status, closes_at);
```

Money in integer cents, timestamps ISO 8601, summaries in our own words (300 characters at most), and no organizer images or logos, the same rules as outings. `removals.yaml` gains a `lot_urls:` list that's honored on every run. `discovery_queue` gets a `kind` column (`outing` | `auction`, default `outing`) in the same migration, so auction searches don't feed the outing extractor.

## Pipeline

A separate weekly run, like the top-course run: `pnpm run pipeline --auctions=<from>-<to> --serp=claude-search --llm=claude-cli`. It runs on this Mac on the owner's subscription, rotates through the list about 40 clubs a run, and makes no paid API calls. Nightly outing runs don't change. No budget cap is raised. It uses the existing per-run search and fetch caps.

1. **Discover.** For each private or resort club on `data/top-courses.json` (The Grove XXIII first):
   - `"{name}" foursome auction`
   - `"{name}" round auction charity`
   - `"{name}" golf auction {year}`, for this year and next
   - `"{short name}" auction golf` when the club has a common short name ("Grove 23", "NGLA", "LACC")

   That's 3 to 4 searches per club, about 150 per run. Result URLs go to `discovery_queue` with `kind = 'auction'`.
2. **Fetch.** The same SSRF guard, robots.txt check, size and time limits, no cookies, and `platforms.yaml` on every hop. A result on a platform with `allowed: false` is never fetched. If a search result shows a lot there, it's stored only as a held search hit (`platform_not_allowed`) for the owner's report and never published.
3. **Extract.** A new strict JSON schema, `auctionLotSchema`, with the same rules as outing extraction: no tools, page text marked untrusted, the output checked again with zod. One page can hold many lots (a gala catalog), so the model returns `lots[]`. Fields: club name as printed, players, member hosted, what's included, organizer, auction name, open and close time with time zone, price kind and amount, stated value, lot URL or anchor.
4. **Classify.** Keep only a round of golf at a named club. Drop lessons, golf gear, pro-shop credit and simulator time. A lot that is really a tournament entry goes to the outing pipeline instead.
5. **Match the course.** The existing matcher, with the top-course list's `osm_ref` pins first. Unmatched lots hold as `course_unmatched`.
6. **Dedupe.** On `lot_url`, then on (course, organizer, closes_at, players).
7. **Publish.** A lot publishes only when all of these hold: the course matched, the source platform is allowed (or it's the organizer's own site and robots allows it), it has a close date in the future, and the owner approved it. Every new lot waits for review (`pnpm run auctions:review`), the same gate the owner chose for top-course outings on 2026-11-19.
8. **Recheck.** Open lots on allowed sources are re-read about every 2 days for the current bid and status. At close they leave every list. Their pages stay up and say "Closed" for 30 days, then return 404.

## Site

- **Course pages:** a "Rounds up for auction" section under the outings. Each card shows the title, players, whether a member hosts, the organizer and auction, the close date and time in the course's time zone, "Current bid $X as of Nov 21" (or starting bid or buy-now price), and a "View the lot" link (`rel="nofollow noopener"`, new tab). Everything renders as text. The section is hidden when a course has no open lot.
- **Home page:** a "Rounds up for auction" module under "Coming up". It shows up to 6 open lots at private clubs on the top-course list, soonest-closing first, with a link to `/golf-auctions` when there are more. Hidden when empty.
- **`/golf-auctions`:** every open lot, soonest-closing first, with a state filter. It's a list page, so filters get `noindex` like the outing filters.
- **Indexing (owner decision):** I'd recommend `noindex, follow` on individual lot pages and leaving them out of sitemaps, because they live for weeks. Course pages and `/golf-auctions` stay indexable. No Event JSON-LD on lots (they aren't events). ItemList on `/golf-auctions`.
- **Copy:** plain and specific. "Foursome with a member at The Grove XXIII. Bidding closes Mar 14 at 9 p.m. ET. Current bid $12,500 as of Mar 2." Never "exclusive", "elite", "prestigious" or "bucket list". A line on every list: "Bidding happens on the organizer's auction site. We don't run auctions or handle payments."

## Tests (written first)

- Golden extraction cases from recorded pages, one per allowed platform plus a gala-catalog PDF, recorded with `pnpm run test:live-extract` only after the owner approves.
- Classification: round vs lesson vs gear vs tournament entry. Matching: "Grove 23", "The Grove", "Grove XXIII" all map to `way/976384744`, and "The Grove" in another state doesn't.
- Publish rules: blocked platform, no close date, past close date, unreviewed.
- Site e2e: the course page section, the home module, a closed lot, and text escaping.

## Phases

1. Migration, `removals.yaml` `lot_urls`, a seed file of hand-entered lots (owner-approved), the course page section and the home module, all on seed data.
2. Discovery, extraction, classification, matching and publish, offline on fixtures (`--dry-run`).
3. Local `--auctions` runs with claude-search and the review CLI.
4. Weekly schedule on this Mac, after the owner has decided on sources.

## Owner decisions needed

1. Approve the new table and the `discovery_queue.kind` column (schema change by migration).
2. Pick which auction sources to allow. The verdicts are in "Sources" below. Nothing is set to `allowed: true`.
3. Index lot pages, or `noindex` as recommended?
4. Private clubs only, or resort and public top courses too (Pebble Beach, Pinehurst, Bandon)?
5. Add the auction kind to `SPEC.md` (routes, data model, golden cases) as an amendment.

## Sources (terms and robots.txt read 2026-11-21; nothing set to `allowed: true`)

robots.txt mostly allows lot pages. The terms are what block us.

| Site | Lot pages | Verdict | Why | Allowed route |
| --- | --- | --- | --- | --- |
| Charitybuzz | charitybuzz.com/product/… | **DENY** | Terms (06/29/2026) ban scraping or "systematically extract data" and framing without written permission | Written permission; no API or feed |
| Handbid | events.handbid.com/auctions/…/item/… | **DENY** | Acceptable Use Policy §14 bans scraping with "spiders, robots, crawlers"; framing banned | Express written consent |
| BiddingOwl | new.biddingowl.com/… | **DENY** | Bans robots, commercial use of site information, deep-linking and framing | Prior written approval |
| ClickBid (cbo.io) | cbo.io events | **DENY** | AUP bans scraping "through use of manual or automated means" | Customer API only, with ClickBid's or the organizer's authorization |
| Qtego | qtego.us bidder sites | **DENY** | Bans "any robot, spider, or other automatic device" | Written consent |
| Givergy / momoGood | givergy.us event sites | **DENY** | Bans links to anything but the home page, and framing | Licence |
| eBay for Charity | ebay.com/itm/… | **DENY** | User Agreement bans robots and scrapers | eBay Developers Program APIs plus eBay Partner Network |
| Network for Good (Bonterra) | <org>.auctions.networkforgood.com/… | **DENY** | Bonterra terms ban robots and scraping, and framing or linking to materials | Bonterra permission |
| PledgeIt | charity.pledgeit.org/c/…/auction/… | **DENY** | Bans bots, scraping and deep-linking without consent | Consent |
| GiveSmart | e.givesmart.com/events/…/i/… | **UNCLEAR** (leans DENY) | Access limited to "viewing the linked pages"; reuse needs permission. Same as the 2026-10-14 verdict | Written permission (Momentive); the Gmail draft from October still applies |
| OneCause | my.onecause.com/event/… (JS app) | **UNCLEAR** (leans DENY) | No reprinting or republishing, no commercial use | Written permission; the October Gmail draft still applies |
| 32auctions | 32auctions.com/organizations/…/auctions/… | **UNCLEAR** | robots.txt explicitly invites crawlers to auction pages, but showing content needs written permission | **Best first permission request** |
| Greater Giving | ggo.bid (JS) | **UNCLEAR** (leans DENY) | Bans commercial or public use of site information | marketing@greatergiving.com |
| BiddingForGood (FrontStream) | auction.biddingforgood.com (JS) | **UNCLEAR** (leans DENY) | No copying, publishing or displaying content | FrontStream permission |
| GalaBid | app.galabid.com (JS) | **UNCLEAR** (leans ALLOW) | Visitor terms are thin; no copying of their IP without permission | Permission |
| Auctria | app.auctria.com event sites | **ALLOW, provisional** | Terms are silent on robots, scraping and reuse, and robots allows event pages. Silent isn't a licence, and public lot rendering isn't confirmed | A courtesy notice |
| School and hospital gala catalogs | the organizer's own site, often PDFs | **Per host** | Each site's robots.txt and terms decide. Many embed or link into the platforms above and inherit their verdict | Check per host; organizer submissions |

The realistic routes are written permission (32auctions first, then Charitybuzz and GiveSmart), eBay's official APIs, and letting organizers submit their own lots.
