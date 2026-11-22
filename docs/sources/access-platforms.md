# Where access opportunities are posted (2026-11-21)

A one-off Claude-search research pass covered all 329 clubs on `data/top-courses.json`: the top 200, then the other 129. For each club it looked for every way a non-member gets on, including charity outings, auction lots, member-for-a-day, stay-and-play, resort and public tee times, qualifiers, pro-ams and charity dinners. It recorded where each listing was posted.

1,309 items were loaded into `access_opportunities`. 1,136 are published, at 253 courses. They came from 506 distinct sites, and most sites appear once: an organizer's own page.

## Platforms that recur

| Platform | Items | Courses | Kinds | Terms verdict (date read) | Can it be a weekly source? |
| --- | ---: | ---: | --- | --- | --- |
| networkforgood.com (Bonterra) | 106 | 68 | auction, outing | DENY: no robots or scraping (2026-10-14, re-read 2026-11-21) | No. Needs Bonterra's permission |
| givesmart.com | 103 | 72 | auction, outing, package | UNCLEAR, leans DENY: viewing only, no reuse | Not yet. A Gmail draft asking permission is already written (unsent) |
| pledgeit.org | 65 | 49 | auction, outing | DENY: no bots, no deep links | No |
| amateurgolf.com | 53 | 47 | qualifier, outing, pro-am | DENY: no bots, no directory building | **Owner decision**: the spec names it as a source |
| zeffy.com | 29 | 24 | auction, outing | DENY: no robots or scrapers | **Owner decision**: it's in registration-hosts |
| charityauctionstoday.com | 26 | 25 | auction | UNCLEAR: consignment packages, no commercial use | No. These are resale packages, not charity lots |
| travelpledgeauctions.com | 25 | 17 | auction, stay-and-play | DENY (Geronimo Solutions terms) | No |
| 32auctions.com | 23 | 20 | auction, outing | UNCLEAR: robots.txt invites crawlers; display needs permission | **Best first permission request** |
| handbid.com | 16 | 10 | auction | DENY | No |
| massgolf.org | 14 | 9 | qualifier, member-for-a-day | not checked | Candidate association calendar: check terms, then owner approval |
| charitybuzz.com | 12 | 8 | auction | DENY | No |
| biddingforgood.com | 11 | 11 | auction | UNCLEAR; robots.txt blocks ClaudeBot | No |
| nepga.com | 9 | 9 | pro-am | not checked | Candidate (pro-ams sell amateur spots) |
| njgolf.org | 6 | 4 | pro-am, outing, qualifier | not checked | Candidate association calendar |
| tpc.com, bandondunesgolf.com, sandvalley.com, streamsongresort.com | 6 to 14 each | 1 to 5 | tee times, stay-and-play | not checked | Course and resort sites: a link per course, no crawl needed |

News and editorial sites (patch.com, thegolfwire.com, golfersjournal.com, thefriedegg.com, golfdigest.com, 27east.com) are where listings were *mentioned*. They aren't sources.

## What this means for the product loop

The idea was to search the top courses, find listings, notice the platforms, then add those platforms as recurring sources. The terms stop the last step for every big charity-auction and event platform. All of them are `allowed: false` in `platforms.yaml`, so the fetch guard skips them. That leaves three routes:

1. **Permission.** Ask 32auctions, GiveSmart and Network for Good in that order. Drafts for GiveSmart and OneCause already exist from October.
2. **Allowed sites.** BetterWorld, Qgiv (`/event/` and `/for/` pages) and RunSignup (`/Race/` pages, 1 request a second) allow crawling. But they have no golf index, so search finds their pages and the pipeline already fetches them. Turning them into formal sources needs owner approval (CLAUDE.md: a source not in SPEC 8.2).
3. **Associations and organizers.** State and PGA section calendars (MassGolf, NEPGA, NJSGA) and the recurring organizers behind most lots (ForeBatten, First Tee chapters, the MacKenzie Benefit, HV3 Foundation, Youth on Course and Coaches vs. Cancer) post on their own sites. They can be checked per site and added like the Arizona, Southern California and Colorado associations.

Search on the owner's subscription (claude-search) stays the discovery engine for everything else.
