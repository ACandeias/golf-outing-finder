# The access timeline: end dates drive what shows, when

Every way onto a course has a day after which it's gone: bidding closes, the event starts, the offer ends. The site uses that day for three things: what order listings appear in, when a listing stops reading as open, and when a recurring listing is expected back.

## The three dates

| Rule | Auction lot | Event (outing, qualifier, pro-am, dinner, other) | Standing offer (member-for-a-day, stay-and-play, resort booking, tee times, package) |
| --- | --- | --- | --- |
| **Act-by day**: where it sits on the timeline | closing day (`date_end`). A lot's start date is never treated as a closing day | first day (`date_start`, else `date_end`) | last day (`date_end`, else `date_start`) |
| **Last day**: after it, the listing reads as closed | `date_end` only. A lot with no closing day never closes on its own | `date_end`, else `date_start` | `date_end`, else `date_start` |
| **Expected back**: for recurring listings that have already happened | the same month and day as last time, in the first year that puts it on or after today | the same | the month the season opened (`date_start`), not the month it ended |

"Today" is the day at the listing's own course. A lot at a New York club that closes Nov 24 says "Bidding closes today" from midnight Eastern, and reads "Closed" from the next midnight Eastern.

The code is `actByDate`, `lastDay` and `liveStatus` in `packages/db/src/access.ts`, `accessTimeline`, `deadlineLabel`, `nextOccurrence` and `monthsSeen` in `apps/site/src/lib/access-timeline.ts`, and the day arithmetic in `apps/site/src/lib/day.ts`. All are pure functions with unit tests.

## What the site shows

- **Status is worked out when the page is requested.** The queries in `@gof/db/access` return each item's status as of today at its course, so a lot stored as open reads "Closed" the day after its closing day without anyone reloading data. The loader still closes past items when it runs, but only once the day has ended everywhere in the US.
- **Cached pages end with the day.** Pages that show countdowns set a cache lifetime that stops at the next midnight at any course on the page (`ttlWithinDay` in `apps/site/src/lib/clock.ts`), so "closes tomorrow" is never served on the closing day.
- **A bid is never shown as a final price.** Once a lot is over, "Current bid $2,500" becomes "Last bid seen $2,500". Only a stored sold price reads "Sold for".
- **`/top-courses` opens with the timeline.**
  - *Coming up*: open and upcoming listings by act-by day. The next 7 days come first, then one group per month. A recurring listing whose dates are still ahead, or under way, is here too.
  - *Expected back*: recurring listings in the month they ran last time, a year on, labeled "Last closed Apr 12, 2026". No day is shown, because nobody has announced one. Only something that has already happened is listed.
  - *Open any time*: open listings with no act-by day, such as tee times, or a lot with no closing date listed.
  - *By course*: everything, as before.
- **Countdowns.** Within 30 days a row says "Bidding closes tomorrow", "Starts in 12 days" or "Ends in 8 days". An event that has started says "Under way until Jan 3, 2027". Past 30 days the date alone is shown.
- **The home page's "Ways onto top courses"** lists open and upcoming listings together, the soonest act-by day first and undated ones last, with the same countdowns.
- **A course page** says which months its dated listings have fallen in ("Dated listings here have fallen in April and November"), so a golfer knows when to look again.

## What isn't built yet

0. **Three dates per listing.** The source research (`docs/sources/first-principles-report.md`) recommends storing when a listing opens, when it closes and the play-by date, each marked stated, estimated or expected, on organizer, series and edition records. Today a listing has a start and an end date and nothing says how sure either is. For association days, media-society events and resort booking windows the opening time is the real deadline. This needs a migration and the owner's approval.
1. **Closing time.** Only the day is stored. A lot that closes at 9 PM Eastern reads "Bidding closes today" all day. An hour-level countdown needs a new nullable column (a closing timestamp with its time zone) in a new migration, and the sources would have to state the time. Most don't.
2. **Rechecks keyed to the end date.** Access items are loaded from research files and the link catalog; the nightly pipeline doesn't recheck them. When it does, the end date should set the schedule, the same way SPEC.md 8.9 does for outings: weekly when the act-by day is more than 30 days out, every 48 hours inside 30 days, once more the day after closing to record the sold price. Only pages on platforms that allow fetching can be rechecked; the rest rely on their stored closing day.
3. **Alerts.** "Tell me when a round at this club is listed" needs accounts or email, which the site doesn't have. Owner decision.
4. **Price history.** Closed lots keep their sold price, so "what a round here has gone for" is a query away. It needs enough closed lots per club to be honest; 281 closed auction lots are stored and 96 of them have a closing day.

## Data on hand (LAN database, 2026-11-23)

1,136 published items. 39 are open or upcoming and about 28 of those have a date ahead of today. 378 are recurring and about 110 of those carry last year's date, which is what the "Expected back" section is built from.
