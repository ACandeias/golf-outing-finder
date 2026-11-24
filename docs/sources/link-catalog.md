# The link catalog: links added by hand

`data/access-links.json` holds listings a person added: a link, plus the facts typed in from a page they opened themselves. Nothing in it is fetched by the crawler. It is empty today (see "Open owner decisions").

## Why it exists

Most sites that list rounds at private clubs forbid crawling. Many of the same sites allow links. A link with a few facts in our own words is a different thing from a crawl, so those listings can be on the site without a crawler touching theirs.

That holds only when two separate questions both come out right for the site in question:

1. **How were the facts learned?** A program that visits a no-bots site to read a closing date is scraping, even if a link is all it keeps.
2. **May the page be linked?** A few sites restrict links themselves.

This is a plain-language summary of `first-principles-report.md`, not legal advice.

## Who may add a listing, by how the facts were learned

| Route | Standing |
| --- | --- |
| The organizer or charity sends the link and the facts | Cleanest. They consent, and their platform is never touched. |
| The platform gives written permission or a feed | Clean. Keep the reply and follow its conditions. |
| The facts are on the organizer's own page, or a page the terms let the crawler read | Clean. |
| A person opens a public page in an ordinary browser and types the facts in | Reasonable where the terms restrict only automated tools. Not settled law. |
| The same, on a site whose terms bar extraction "by any means" or commercial use of its content (Member For a Day is one) | Medium risk. Ask for written permission first. |
| A script, a headless browser or an AI browsing agent reads the page | Not a person. Treated the same as a crawler. Don't. |

## What may go in

| Rule | Why |
| --- | --- |
| The title is in our own words, 120 characters at most. No copied text, no images, no logos. | CLAUDE.md data rules. |
| Facts only: club, state, kind, organizer, closing day, players, the price seen. | Facts can be restated; the organizer's wording can't be copied. |
| `checked_on` is the day the person looked. | The site shows "Checked Nov 23, 2026" next to a bid, so nobody reads an old bid as today's. |
| An open or upcoming auction lot has `date_end`, its closing day. | The lot then leaves the timeline and reads "Closed" by itself. |
| `platform` is the site the link opens. | The button says "View on …". |
| No link past the home page of a site whose terms restrict links. | Those sites carry `deep_links: false` in `data/overrides/platforms.yaml`. |

`packages/pipeline/src/access/links.ts` enforces every row of this table except the first two, which are on the person adding the link. `pnpm test` fails if the file breaks a rule.

## Sites that restrict links (2026-11-24)

`deep_links: false` in `platforms.yaml`: WinningBidder and Travel Pledge, BiddingOwl, Givergy, PledgeIt, AJGA, Mastercard Priceless, TPC, Invited, Troon, BlueGolf, the New York State, Maryland and Wisconsin golf associations. A stored listing that links past their home page is held until the site says yes. Maryland asks for consent before any link at all.

Member For a Day allows links to its home page, auction pages and scheduling pages, from your own site, with no implied endorsement. It can withdraw that at any time.

## How to add or change a listing

1. Add an entry to `data/access-links.json`. `tests/fixtures/access-e2e.json` shows the fields; add `checked_on`.
2. Run `pnpm test`. It checks the file.
3. Run `pnpm run access:load` to load it into the local database. Add `--persist-to=<dir>` for another state directory.

To change a listing that is already loaded (a new bid, the sold price, a corrected closing day), edit the entry, set `checked_on` to the day you checked, and load again. The stored row is updated when the entry's `checked_on` is the same day as the stored check or later, so an old copy of the file never overwrites a newer check.

The link, kind, course name and title together identify a listing. Changing any of them creates a second listing; the first one stays until it is removed.

## Taking a listing down

Add its link to `data/overrides/removals.yaml`. The next load unpublishes every stored listing on that link and holds any catalog entry that uses it. This is the same file that takes outings down at an organizer's request. Any objection from a site is final.

## What the catalog is not

- **Not a way around a crawl ban.** `allowed: false` in `platforms.yaml` still means the pipeline never fetches the site.
- **Not automatic.** Someone has to look at the page. Bids move by the minute, so an entry is a pointer with a dated snapshot, not a live price.

## Open owner decisions

1. **Who enters links.** The site is meant to run unattended. The best sources need a person a few times a year, or a written yes.
2. **Member For a Day.** On 2026-11-23 an AI agent typed in ten lots from the First Tee Greater Detroit page as a demonstration. By the table above that is not hand entry, so the entries were taken back out of this file on 2026-11-24. They remain in the branch history and in the LAN preview database. Ask Member For a Day for permission (draft in `permission-requests.md`), then decide.
