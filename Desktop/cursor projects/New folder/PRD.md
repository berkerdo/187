1) Problem

We need an automatic, seedless keyword discovery and scoring system for Etsy. It should find phrases with high demand / low competition and export a ranked CSV with supporting metrics. No paid APIs. Must be robust to rate limits and minor DOM changes.

2) Users & outcomes

You (shop owner): Get a daily/weekly CSV of strongest keywords, with transparent reasons (metrics) to use in titles/tags/collections.

Agent (GPT-5 Medium in Cursor): Can run end-to-end with limited supervision, leveraging Playwright MCP and local Python helpers.

3) Non-goals

Not a full listing auto-publisher.

Not circumventing hard bot protections. We’ll be gentle and respect ToS; optional Web Unblocker can be used if your proxy contract allows it.

4) Success metrics

≥ 200 new unique candidate keywords per run (configurable).

≥ 90% successful page fetch/parse rate.

Clear winners: top 50 keywords have sensible supporting stats (spot-check passes).

5) Data sources (no paid tools)

Etsy: search pages, category/browse pages, listing pages (to sample favorites & review recency), autocomplete UI.

Google Trends (optional but recommended): via pytrends for 12-month average interest.

Google & Etsy Autocomplete: to expand candidates.

Local cache (SQLite): to avoid refetching.

6) Key metrics & scoring

Demand proxies

trends_avg_12m (pytrends)

review_velocity (median of sampled listings’ recent reviews / day, 30-day window)

favorites_avg (mean/median of sampled favorites)

price_median (sanity metric; not part of demand but reported)

Competition proxies

results_count (Etsy search total)

ad_ratio (share of ads on page 1)

dominance_index (HHI over shops occupying top-48)

price_dispersion (IQR/median)

Scores

demand = T + w1·V + w2·F

competition = Rn + w3·A + w4·D + w5·P

opportunity = demand / (1 + competition)
Default weights: w1=1.0, w2=0.5, w3=0.8, w4=0.7, w5=0.4.
All inputs are robust-normalized (median/IQR). Rn=normalize(log1p(results_count)).

7) Seedless discovery strategy (important)

We don’t start with product seeds. We discover candidates via:

A) Autocomplete enumeration (budgeted)

Query Etsy’s search box suggestions using alphabet walkers:
prefixes = ['a','b',...,'z','aa','ab','ac',...,'zz'] (depth-limited; stop expanding when suggestion yield < threshold).

Also query Google suggestions with “etsy + prefix” to harvest marketplace-relevant phrases.

B) Category & trending harvest

Crawl top Etsy category/browse/trending pages (limited depth): collect listing titles and visible tags → extract noun phrases → candidate keywords.

C) Prune early

Discard phrases that:

< 2 chars, or only stopwords

clearly navigational/brand-only terms you can’t target

violate marketplace rules for your shop category

Keep a configurable discovery budget (e.g., 3–10k raw candidates), then pre-filter by quick signals:

cheap head request for results count (if available)

keep those within min/max results bounds.

8) Architecture (Cursor-native)

Controller (TypeScript/Node): Orchestrates the run. Calls Playwright MCP tools and Python helpers. Handles rate-limit pacing and retries.

Browser Agent (Playwright MCP): Fetches pages, extracts HTML, sometimes evaluates DOM to detect badges/labels.

Extractor (Python): Fast HTML parsing + normalization (e.g., selectolax or your preferred “pyextracter”).

Also runs pytrends and date math for review velocity.

Cache/Store: SQLite (data/cache.db). Stores raw HTML (short-term), parsed rows, and final snapshots.

Scoring: JS or Python (either is fine; recommend one place—Python—for numeric stability).

Exporter: writes CSV to data/outputs/run_YYYY-MM-DD.csv.

9) Rate-limit & resilience

Concurrency: 2–3 max.

Randomized waits: 2–7s between keyword fetches; jitter on page interactions.

Rotate UAs (small, realistic pool).

Optional proxy / Web Unblocker via env config; only use when necessary (e.g., repeated 429/403 or captcha signal).

Exponential backoff on transient errors.

HTML schema changes: write selector fallbacks; prefer semantic markers (ARIA labels, visible text) and safe regex.

10) Config & secrets

configs/settings.yaml

geo: Trends region ('', US, GB, TR, …)

pages_to_sample: 2–3 (48–72 results)

discovery_budget: e.g., 3000 suggestions max

min_results, max_results: coarse competition bounds

weights: w1..w5

proxy: optional; when and how to apply

sleep_min_ms, sleep_max_ms

.env

WEB_UNBLOCKER_URL, WEB_UNBLOCKER_AUTH (optional)

PYTRENDS_TZ, etc.

11) Data model (SQLite)

keywords(seedless_id TEXT, keyword TEXT, source TEXT, first_seen_ts, last_seen_ts, PRIMARY KEY(keyword, source))

serp_cache(keyword TEXT, page INTEGER, fetched_ts, html TEXT, PRIMARY KEY(keyword,page))

listings(keyword TEXT, position INTEGER, listing_id TEXT, is_ad INTEGER, title TEXT, shop TEXT, price REAL, review_count INTEGER, favorites INTEGER, url TEXT, PRIMARY KEY(keyword, position))

search_snapshot(keyword TEXT PRIMARY KEY, results_count INTEGER, ad_ratio REAL, dominance_index REAL, price_median REAL, price_iqr_over_median REAL, favorites_avg REAL, review_velocity REAL, trends_avg REAL, opportunity_score REAL, computed_ts)

trends_cache(keyword TEXT PRIMARY KEY, window TEXT, avg_value REAL, series_json TEXT, fetched_ts)

12) Pipeline steps

Discover candidates (Autocomplete + Category/Trending harvest)
→ dedupe, normalize.

Pre-filter by very cheap checks (if any).

For each keyword (batch 1–2):

Fetch page-1 & page-2 search HTML (Playwright MCP; proxy if needed).

Parse results_count, ad_ratio, top cards (title, shop, price, review_count, ad badge).

Sample 6–10 listing pages → favorites, recent review timestamps → review_velocity.

Google Trends: trends_avg_12m (pytrends).

Compute dominance index (HHI on shop shares top-48) & price_median, price_iqr_over_median.

Score → opportunity_score.

Export CSV and optional JSONL (for future training).

Write mini “why it ranks” string for top 50 (for quick QA).

13) Testing

Unit: selector functions, normalizers, trends wrapper, scoring math.

Golden pages: keep a few cached HTMLs to avoid hitting Etsy during tests.

Smoke: run with discovery_budget=50, pages=1.

14) Observability

Structured logs (JSON): page fetch timings, retry counts, captcha detections, parse stats per keyword.

Summary at end: counts by status, top 10 wins, slowest pages.

15) Risks & mitigations

DOM drift → selector fallbacks + quick hotfix file.

Captcha → slower pacing, backoff, optional proxy.

Over-broad discovery → configurable budgets and pruning.