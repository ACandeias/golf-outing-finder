# The link catalog: links added by hand

`data/access-links.json` holds listings a person added: a link, plus the facts typed in from a page they opened themselves. Nothing in it is fetched by the crawler.

## Why it exists

Most sites that list rounds at private clubs forbid crawling. Many of the same sites allow links. Member For a Day's terms, for example, ban any "robot, spider, script" that extracts or indexes the site, and also say visitors may link to its home page and auction pages. A link with a few facts in our own words is a different thing from a crawl, so those listings can be on the site without a crawler ever touching theirs.

## What may go in

| Rule | Why |
| --- | --- |
| The link came from a person: the owner pasted it, an organizer sent it, or it was seen in a search result. | No automated visit to a site that forbids one. |
| The title is in our own words, 120 characters at most. No copied text, no images, no logos. | CLAUDE.md data rules. |
| Facts only: club, state, kind, organizer, closing day, players, the price seen. | Facts can be restated; the organizer's wording can't be copied. |
| `checked_on` is the day the person looked. | The site shows "Checked Nov 23, 2026" next to a bid, so nobody reads an old bid as today's. |
| An open or upcoming auction lot has `date_end`, its closing day. | The lot then leaves the timeline and reads "Closed" by itself. |
| `platform` is the site the link opens. | The button says "View on …". |
| No link past the home page of a site whose terms allow home-page links only. | Those sites carry `deep_links: false` in `data/overrides/platforms.yaml`. |

`packages/pipeline/src/access/links.ts` enforces every row of this table except the first two, which are on the person adding the link. `pnpm test` fails if the file breaks a rule.

## How to add or change a listing

1. Add an entry to `data/access-links.json`. Copy an existing one and change the fields.
2. Run `pnpm test`. It checks the file.
3. Run `pnpm run access:load` to load it into the local database. Add `--persist-to=<dir>` for another state directory.

To change a listing that is already loaded (a new bid, the sold price, a corrected closing day), edit the entry, set `checked_on` to the day you checked, and load again. The stored row is updated when the entry's `checked_on` is the same day or later than the stored one, so an old copy of the file never overwrites a newer check.

The link, kind, course name and title together identify a listing. Changing any of them creates a second listing; the first one stays until it is removed.

## Taking a listing down

Add its link to `data/overrides/removals.yaml`. The next load unpublishes every stored listing on that link and holds any catalog entry that uses it. This is the same file that takes outings down at an organizer's request.

## What the catalog is not

- **Not a way around a crawl ban.** `allowed: false` in `platforms.yaml` still means the pipeline never fetches the site. The catalog doesn't change that.
- **Not automatic.** Someone has to look at the page. Bids move by the minute, so a catalog entry is a pointer with a dated snapshot, not a live price.
- **Not legal advice.** A site's terms can restrict more than the law does. Where the terms say no deep links, the catalog refuses them. For anything else in doubt, ask the site.

## Open owner decision

Should hand-added links to sites that ban crawling go to production, or only after each site says yes? The first ten entries (First Tee Greater Detroit's lots on Member For a Day, closing 2026-11-24) are on the LAN preview only.
