# Golf Outing Finder

A nationwide directory of golf outings that anyone can pay to enter, at any kind of course: municipal, public, semi-private, private or resort. It's free to use, earns money only from display ads, and runs unattended. The full build spec is in `SPEC.md`. The seed dataset is in `seed/outings.json`.

## How to work in this repo

- Build one phase at a time from `SPEC.md` section 13. Start each phase in plan mode, list the tasks, then implement. Stop when the phase's acceptance criteria pass and summarize what passed and what didn't.
- Write tests first for anything in `packages/pipeline`. The golden cases in `SPEC.md` section 11 are the source of truth for extraction, classification and matching.
- Never call a paid API (SERP provider, Claude API) outside `pnpm pipeline --live` or `pnpm test:live-extract`. Every other run uses fixtures and recorded responses.
- Check current docs before using a third-party API or framework feature. Versions, prices and limits in `SPEC.md` were checked in September 2026 and may have changed.
- Ask the owner before adding a dependency, changing the schema outside a migration, raising a budget cap, or adding a data source not listed in `SPEC.md` section 8.2.

## Commands

```bash
pnpm install
pnpm dev                          # Astro + wrangler dev with a local D1
pnpm test                         # unit + golden tests, offline
pnpm test:e2e                     # Playwright against wrangler dev with seeded D1
pnpm lint && pnpm typecheck
pnpm db:migrate:local             # apply migrations to local D1
pnpm db:migrate:remote            # apply migrations to production D1 (CI only)
pnpm run seed                     # load seed/outings.json into local D1
pnpm run pipeline --dry-run       # full pipeline on fixtures, zero network calls
pnpm run pipeline --live --budget=nightly  # real run; used by nightly.yml
pnpm run test:live-extract        # re-record LLM fixtures (costs money, asks first)
pnpm build && pnpm deploy         # deploy the Worker (CI only)
```

`pnpm run pipeline` (not `pnpm pipeline`) — `pipeline` is a reserved pnpm 12 subcommand.

## Code conventions

- TypeScript strict in every package. Node 22 LTS. pnpm workspaces.
- Validate every external input with zod: env vars, API responses, fetched pages, LLM output, form input.
- Money is integer cents. Dates are ISO 8601. Outing times are stored as local wall time plus the course's IANA time zone.
- No `any`. Named exports everywhere except Astro pages.
- Pipeline stages are pure functions; network and database I/O happen only at the edges so stages test offline.

## Security rules

- Secrets come only from environment variables and GitHub Actions secrets. Never log them or write them to fixtures.
- Treat every fetched page as hostile. Use the SSRF guard, size and time limits, no cookies, no stored credentials.
- Scraped text never reaches a page as HTML. Render it as text. Never use `set:html` or `innerHTML` with anything from the database.
- The extraction call to the Claude API has no tools and a strict JSON schema, and the prompt says page text is untrusted. Validate the output again with zod before it touches the database.
- Pin every GitHub Action to a full commit SHA. Default workflow permissions are `contents: read`.

## Data and content rules

- Respect robots.txt and each platform's terms. The crawler identifies itself as `GolfOutingFinderBot/1.0 (+{SITE_URL}/bot)`.
- Don't copy organizer text. Summaries are written in our own words, 300 characters at most, and every listing links to its source.
- No organizer images and no club logos.
- Course data from OpenStreetMap requires "© OpenStreetMap contributors" on the map and on course pages.
- Honor `data/overrides/removals.yaml` on every run.

## Site copy

Plain, friendly and specific: what the outing is, where, when, what it costs and what's included. Never use "exclusive", "elite", "prestigious" or "bucket list". A $125 muni scramble gets the same treatment as a private club outing.

## Definition of done for any change

- lint, typecheck and tests pass
- no budget cap raised without the owner's approval
- the SEO checks in `SPEC.md` section 9.4 still hold: JSON-LD validates, every page has a canonical, and the noindex rules are unchanged
