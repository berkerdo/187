# Etsy Keyword Discovery Pipeline

This repository hosts a seedless keyword discovery, enrichment, and scoring system for Etsy inspired by the accompanying product requirements document. The pipeline is orchestrated in TypeScript and coordinates Playwright-driven crawlers with Python helpers for Google Trends analysis.

## Getting started

1. Install Node.js 18+ and Python 3.11+.
2. Install Node dependencies:

   ```bash
   npm install
   ```

3. Install Playwright browser binaries (required before crawling):

   ```bash
   npx playwright install
   ```

4. Set up the Python helper environment (for Google Trends):

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r python/requirements.txt
   ```

5. Copy `.env` (or edit the checked-in stub) and update the secrets:

   - `WEB_UNBLOCKER_URL` / `WEB_UNBLOCKER_AUTH` for optional proxy access.
   - `PYTRENDS_TZ` and `PYTRENDS_PROXY` for Google Trends.
   - `PYTHON_PATH` if the Python binary is not discoverable as `python3`.

6. Adjust the default configuration in `configs/settings.yaml`.

Run the orchestrator with:

```bash
npm run dev
```

The bootstrap process now performs the full end-to-end flow: autocomplete discovery, category & trending harvest, keyword pre-filtering, SERP fetching, listing sampling, Google Trends enrichment, opportunity scoring, and CSV export.

## Project structure

```
configs/            # YAML configuration files
src/                # TypeScript orchestrator source
  autocomplete/     # Autocomplete discovery walker
  harvesters/       # Category & trending crawlers
  filtering/        # Keyword pre-filter logic
  search/           # Search page fetchers and listing sampler
  scoring/          # Opportunity score computation
  trends/           # Google Trends client wrapper
  export/           # CSV export utilities
  utils/            # Shared utilities (logging, text helpers, stats)
python/             # Python helpers (pytrends CLI)
data/               # SQLite database and caches (gitignored)
outputs/            # Generated CSV exports (gitignored)
```

## Pipeline overview

The orchestrator executes the following stages in sequence:

1. **Autocomplete enumeration** — Walks Etsy and Google suggestion APIs, normalizes results, and persists them to the keyword store.
2. **Category & trending harvest** — Crawls configured browse and trending URLs, extracts noun phrases from listing titles/tags, and records them as additional keyword candidates.
3. **Keyword pre-filtering** — Applies lexical heuristics, stopword checks, repeat guards, and optional quick SERP estimates to prune irrelevant or non-compliant phrases early.
4. **SERP fetching** — Uses Playwright to download the first pages of Etsy search results, capturing listing metadata, ad share, dominance, and optional raw HTML cache entries.
5. **Listing sampling** — Visits individual listing pages to gather favorites, price, and recent review tempos for review velocity calculations.
6. **Google Trends integration** — Invokes `python/trends_fetcher.py` to fetch 12-month interest averages and time series for surviving keywords.
7. **Opportunity scoring** — Normalizes demand and competition proxies (trends, review velocity, favorites, results count, ad ratio, dominance, price dispersion) and computes the final opportunity score per keyword.
8. **CSV export** — Writes a ranked CSV with component breakdowns and "why it ranks" summaries for the top candidates.

Each phase emits structured logs with timing information and representative samples for quick inspection.

## Configuration highlights

`configs/settings.yaml` now includes dedicated sections for every stage:

- `discovery.autocomplete` — Alphabet walker settings and source toggles.
- `discovery.category_trending` — URLs, depth, and noun phrase extraction parameters for browse/trending harvests.
- `filtering` — Keyword hygiene rules, stopword list, forbidden patterns, and optional head-request budget checks.
- `search` — Number of search pages, selector fallbacks, pacing, and HTML capture controls.
- `sampling` — Listing sample counts, pacing, and review window configuration.
- `trends` — Batch sizing and Geo/Lookback options for Google Trends.
- `exporter` — CSV limits and explanation settings.
- `observability` — Logging verbosity knobs for sampling and summary output.

Environment-specific toggles live in `.env`, while database and output locations reside under `paths`.

## Data model

The SQLite store (`data/cache.db`) now manages the full set of artifacts:

- `keywords` & `autocomplete_suggestions` — Normalized discovery trail per source.
- `harvested_keywords` — Category/trending harvest metadata.
- `prefiltered_keywords` — Keywords that survived pre-filtering with bookkeeping on length/token counts.
- `serp_cache` & `listings` — Captured search HTML and structured listing rows across pages.
- `search_results_metadata` — Aggregated SERP metrics such as results count, ad ratio, and dominance index.
- `keyword_listing_metrics` — Favorites, review velocity, and price dispersion derived from sampled listings.
- `trends_cache` — Cached Google Trends snapshots.
- `search_snapshot` — Final demand, competition, and opportunity scores with component breakdowns.

## Troubleshooting

- **Playwright permissions** — Ensure `npx playwright install` has been run and any proxy credentials are present in `.env`.
- **Google Trends throttling** — Adjust `trends.batch_size` and `trends.sleep_between_batches_ms`, or supply `PYTRENDS_PROXY` to route through an unblocker.
- **Incomplete scoring** — Check logs for missing SERP or listing metrics; the scorer skips keywords without the necessary data points.

## Development scripts

- `npm run dev` — Run the pipeline with live TypeScript via `ts-node-dev`.
- `npm run build` — Emit compiled JavaScript to `dist/`.
- `npm run typecheck` — TypeScript type-check (requires dependencies to be installed locally).
