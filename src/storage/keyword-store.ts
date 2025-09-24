import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import sqlite3 from 'sqlite3';

import type { AutocompleteSuggestion } from '../autocomplete/types';
import { Logger } from '../utils/logger';
import { normalizeKeyword } from '../utils/text';
import { iqr, median } from '../utils/stats';
import type {
  GoogleTrendsRecord,
  HarvestedKeywordRecord,
  KeywordCandidateRecord,
  ListingRowRecord,
  ListingSampleRecord,
  OpportunitySnapshotRecord,
  PrefilteredKeywordRecord,
  SearchResultRecord,
  SearchResultsMetadataRecord
} from './types';

const OPEN_FLAGS = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;

function hashKeyword(source: string, keyword: string): string {
  return createHash('sha1').update(`${source}:${keyword}`).digest('hex');
}

function toJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ fallback: String(value), serializationError: true });
  }
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    return undefined;
  }
}

function computeDominanceIndex(listings: SearchResultRecord['listings']): number | null {
  if (listings.length === 0) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const listing of listings) {
    const shop = listing.shop?.toLowerCase().trim();
    if (!shop) {
      continue;
    }
    counts.set(shop, (counts.get(shop) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return null;
  }

  const total = listings.length;
  let hhi = 0;
  for (const value of counts.values()) {
    const share = value / total;
    hhi += share * share;
  }

  return hhi;
}

function computePriceStats(listings: SearchResultRecord['listings']): {
  median: number | null;
  dispersion: number | null;
} {
  const prices = listings
    .map((listing) => listing.price)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (prices.length === 0) {
    return { median: null, dispersion: null };
  }
  const med = median(prices);
  if (med === null || med === 0) {
    return { median: med, dispersion: null };
  }
  const spread = iqr(prices);
  if (spread === null) {
    return { median: med, dispersion: null };
  }
  return { median: med, dispersion: spread / med };
}

export class KeywordStore {
  private constructor(private readonly db: sqlite3.Database, private readonly logger: Logger) {}

  static async initialize(dbFile: string, logger: Logger): Promise<KeywordStore> {
    const resolvedPath = resolve(process.cwd(), dbFile);
    mkdirSync(dirname(resolvedPath), { recursive: true });

    const database = await new Promise<sqlite3.Database>((resolveDb, rejectDb) => {
      const db = new sqlite3.Database(resolvedPath, OPEN_FLAGS, (err) => {
        if (err) {
          rejectDb(err);
          return;
        }
        resolveDb(db);
      });
    });

    const store = new KeywordStore(database, logger);
    await store.bootstrap();
    return store;
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolveExec, rejectExec) => {
      this.db.exec(sql, (err) => {
        if (err) {
          rejectExec(err);
          return;
        }
        resolveExec();
      });
    });
  }

  private run(sql: string, params: unknown[]): Promise<number> {
    return new Promise((resolveRun, rejectRun) => {
      this.db.run(sql, params, function runCallback(err) {
        if (err) {
          rejectRun(err);
          return;
        }
        resolveRun(this.changes ?? 0);
      });
    });
  }

  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolveAll, rejectAll) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          rejectAll(err);
          return;
        }
        resolveAll(rows as T[]);
      });
    });
  }

  private async bootstrap(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS keywords (
        seedless_id TEXT NOT NULL,
        keyword TEXT NOT NULL,
        source TEXT NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        PRIMARY KEY(keyword, source)
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS autocomplete_suggestions (
        keyword TEXT NOT NULL,
        source TEXT NOT NULL,
        prefix TEXT NOT NULL,
        rank INTEGER NOT NULL,
        payload TEXT,
        fetched_ts INTEGER NOT NULL,
        PRIMARY KEY(keyword, source, prefix)
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS harvested_keywords (
        keyword TEXT NOT NULL,
        source TEXT NOT NULL,
        url TEXT NOT NULL,
        context TEXT,
        discovered_ts INTEGER NOT NULL,
        PRIMARY KEY(keyword, source, url)
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS prefiltered_keywords (
        keyword TEXT PRIMARY KEY,
        length INTEGER NOT NULL,
        tokens INTEGER NOT NULL,
        sources TEXT NOT NULL,
        reasons TEXT NOT NULL,
        results_estimate INTEGER,
        updated_ts INTEGER NOT NULL
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS serp_cache (
        keyword TEXT NOT NULL,
        page INTEGER NOT NULL,
        fetched_ts INTEGER NOT NULL,
        html TEXT,
        PRIMARY KEY(keyword, page)
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        keyword TEXT NOT NULL,
        position INTEGER NOT NULL,
        page INTEGER NOT NULL,
        listing_id TEXT NOT NULL,
        is_ad INTEGER NOT NULL,
        title TEXT,
        shop TEXT,
        price REAL,
        review_count INTEGER,
        favorites INTEGER,
        url TEXT,
        PRIMARY KEY(keyword, position)
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS search_results_metadata (
        keyword TEXT PRIMARY KEY,
        results_count INTEGER,
        ads_count INTEGER NOT NULL,
        organic_count INTEGER NOT NULL,
        ad_ratio REAL,
        dominance_index REAL,
        price_median REAL,
        price_iqr_over_median REAL,
        top_cards TEXT,
        pages_fetched INTEGER NOT NULL,
        fetched_ts INTEGER NOT NULL
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS keyword_listing_metrics (
        keyword TEXT PRIMARY KEY,
        sample_size INTEGER NOT NULL,
        favorites_avg REAL,
        favorites_median REAL,
        review_velocity REAL,
        price_median REAL,
        price_iqr_over_median REAL,
        payload TEXT,
        sampled_ts INTEGER NOT NULL
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS trends_cache (
        keyword TEXT PRIMARY KEY,
        window TEXT NOT NULL,
        avg_value REAL,
        series_json TEXT,
        fetched_ts INTEGER NOT NULL
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS search_snapshot (
        keyword TEXT PRIMARY KEY,
        results_count INTEGER,
        ad_ratio REAL,
        dominance_index REAL,
        price_median REAL,
        price_iqr_over_median REAL,
        favorites_avg REAL,
        review_velocity REAL,
        trends_avg REAL,
        demand_score REAL,
        competition_score REAL,
        opportunity_score REAL,
        components TEXT,
        computed_ts INTEGER NOT NULL
      )
    `);

    await this.exec('CREATE INDEX IF NOT EXISTS idx_keywords_source ON keywords(source)');
    await this.exec('CREATE INDEX IF NOT EXISTS idx_autocomplete_fetched ON autocomplete_suggestions(fetched_ts)');
    await this.exec('CREATE INDEX IF NOT EXISTS idx_listings_keyword ON listings(keyword)');
    await this.exec('CREATE INDEX IF NOT EXISTS idx_serp_cache_keyword ON serp_cache(keyword)');
  }

  private async upsertKeywordSource(keyword: string, source: string, timestamp: number): Promise<void> {
    const seedlessId = hashKeyword(source, keyword);
    await this.run(
      `INSERT INTO keywords (seedless_id, keyword, source, first_seen_ts, last_seen_ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(keyword, source) DO UPDATE SET last_seen_ts=excluded.last_seen_ts`,
      [seedlessId, keyword, source, timestamp, timestamp]
    );
  }

  async saveSuggestions(suggestions: AutocompleteSuggestion[]): Promise<number> {
    if (suggestions.length === 0) {
      return 0;
    }

    const timestamp = Date.now();
    let processed = 0;

    await this.exec('BEGIN');
    try {
      for (const suggestion of suggestions) {
        const normalizedKeyword = normalizeKeyword(suggestion.keyword);
        if (!normalizedKeyword) {
          this.logger.debug('Skipping suggestion due to normalization failure', {
            keyword: suggestion.keyword,
            source: suggestion.source
          });
          continue;
        }

        await this.upsertKeywordSource(normalizedKeyword, suggestion.source, timestamp);

        await this.run(
          `INSERT INTO autocomplete_suggestions (keyword, source, prefix, rank, payload, fetched_ts)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(keyword, source, prefix) DO UPDATE SET
             rank=excluded.rank,
             payload=excluded.payload,
             fetched_ts=excluded.fetched_ts`,
          [
            normalizedKeyword,
            suggestion.source,
            suggestion.prefix,
            suggestion.rank,
            toJson(suggestion.payload ?? { raw: suggestion.keyword }),
            timestamp
          ]
        );

        processed += 1;
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }

    return processed;
  }

  async saveHarvestedKeywords(records: HarvestedKeywordRecord[]): Promise<number> {
    if (records.length === 0) {
      return 0;
    }

    const timestamp = Date.now();
    let processed = 0;

    await this.exec('BEGIN');
    try {
      for (const record of records) {
        const normalized = normalizeKeyword(record.keyword);
        if (!normalized) {
          continue;
        }

        const sourceKey = record.source === 'category' ? 'etsy_category' : 'etsy_trending';
        await this.upsertKeywordSource(normalized, sourceKey, timestamp);

        await this.run(
          `INSERT INTO harvested_keywords (keyword, source, url, context, discovered_ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(keyword, source, url) DO UPDATE SET discovered_ts=excluded.discovered_ts`,
          [normalized, sourceKey, record.url, toJson(record.context), timestamp]
        );

        processed += 1;
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }

    return processed;
  }

  async getKeywordCandidates(): Promise<KeywordCandidateRecord[]> {
    const rows = await this.all<{ keyword: string; sources: string | null }>(
      `SELECT keyword, GROUP_CONCAT(source, '||') AS sources FROM keywords GROUP BY keyword`
    );

    return rows.map((row) => ({
      keyword: row.keyword,
      sources: row.sources ? row.sources.split('||').filter(Boolean) : []
    }));
  }

  async savePrefilteredKeywords(records: PrefilteredKeywordRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const timestamp = Date.now();

    await this.exec('BEGIN');
    try {
      for (const record of records) {
        await this.run(
          `INSERT INTO prefiltered_keywords (keyword, length, tokens, sources, reasons, results_estimate, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(keyword) DO UPDATE SET
             length=excluded.length,
             tokens=excluded.tokens,
             sources=excluded.sources,
             reasons=excluded.reasons,
             results_estimate=excluded.results_estimate,
             updated_ts=excluded.updated_ts`,
          [
            record.keyword,
            record.length,
            record.tokens,
            toJson(record.sources),
            toJson(record.reasons),
            record.resultsEstimate ?? null,
            timestamp
          ]
        );
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async getPrefilteredKeywords(): Promise<PrefilteredKeywordRecord[]> {
    const rows = await this.all<{
      keyword: string;
      length: number;
      tokens: number;
      sources: string;
      reasons: string;
      results_estimate: number | null;
    }>(`SELECT keyword, length, tokens, sources, reasons, results_estimate FROM prefiltered_keywords`);

    return rows.map((row) => ({
      keyword: row.keyword,
      length: row.length,
      tokens: row.tokens,
      sources: parseJson<string[]>(row.sources) ?? [],
      reasons: parseJson<string[]>(row.reasons) ?? [],
      resultsEstimate: row.results_estimate
    }));
  }

  async saveSearchResults(results: SearchResultRecord[]): Promise<void> {
    if (results.length === 0) {
      return;
    }

    await this.exec('BEGIN');
    try {
      for (const result of results) {
        const normalized = normalizeKeyword(result.keyword);
        if (!normalized) {
          continue;
        }

        const adsCount = result.listings.filter((listing) => listing.isAd).length;
        const organicCount = result.listings.length - adsCount;
        const adRatio = result.listings.length > 0 ? adsCount / result.listings.length : null;
        const dominanceIndex = computeDominanceIndex(result.listings);
        const priceStats = computePriceStats(result.listings);

        await this.run('DELETE FROM listings WHERE keyword=?', [normalized]);

        for (const listing of result.listings) {
          await this.run(
            `INSERT INTO listings (keyword, position, page, listing_id, is_ad, title, shop, price, review_count, favorites, url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              normalized,
              listing.position,
              listing.page,
              listing.listingId,
              listing.isAd ? 1 : 0,
              listing.title ?? null,
              listing.shop ?? null,
              listing.price ?? null,
              listing.reviewCount ?? null,
              listing.favorites ?? null,
              listing.url ?? null
            ]
          );
        }

        if (result.rawHtml) {
          for (const [pageStr, html] of Object.entries(result.rawHtml)) {
            const pageNumber = Number.parseInt(pageStr, 10);
            if (Number.isNaN(pageNumber)) {
              continue;
            }
            await this.run(
              `INSERT INTO serp_cache (keyword, page, fetched_ts, html)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(keyword, page) DO UPDATE SET fetched_ts=excluded.fetched_ts, html=excluded.html`,
              [normalized, pageNumber, result.fetchedAt, html]
            );
          }
        }

        await this.run(
          `INSERT INTO search_results_metadata (
             keyword, results_count, ads_count, organic_count, ad_ratio, dominance_index, price_median,
             price_iqr_over_median, top_cards, pages_fetched, fetched_ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(keyword) DO UPDATE SET
             results_count=excluded.results_count,
             ads_count=excluded.ads_count,
             organic_count=excluded.organic_count,
             ad_ratio=excluded.ad_ratio,
             dominance_index=excluded.dominance_index,
             price_median=excluded.price_median,
             price_iqr_over_median=excluded.price_iqr_over_median,
             top_cards=excluded.top_cards,
             pages_fetched=excluded.pages_fetched,
             fetched_ts=excluded.fetched_ts`,
          [
            normalized,
            result.resultsCount ?? null,
            adsCount,
            organicCount,
            adRatio,
            dominanceIndex,
            priceStats.median,
            priceStats.dispersion,
            toJson(result.topCards),
            result.pagesFetched,
            result.fetchedAt
          ]
        );
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async getSearchResultsMetadata(): Promise<SearchResultsMetadataRecord[]> {
    const rows = await this.all<{
      keyword: string;
      results_count: number | null;
      ads_count: number;
      organic_count: number;
      ad_ratio: number | null;
      dominance_index: number | null;
      price_median: number | null;
      price_iqr_over_median: number | null;
      top_cards: string | null;
      pages_fetched: number;
      fetched_ts: number;
    }>(
      `SELECT keyword, results_count, ads_count, organic_count, ad_ratio, dominance_index, price_median,
              price_iqr_over_median, top_cards, pages_fetched, fetched_ts
         FROM search_results_metadata`
    );

    return rows.map((row) => ({
      keyword: row.keyword,
      resultsCount: row.results_count,
      adsCount: row.ads_count,
      organicCount: row.organic_count,
      adRatio: row.ad_ratio,
      dominanceIndex: row.dominance_index,
      priceMedian: row.price_median,
      priceIqrOverMedian: row.price_iqr_over_median,
      topCards: parseJson<string[]>(row.top_cards) ?? [],
      pagesFetched: row.pages_fetched,
      fetchedAt: row.fetched_ts
    }));
  }

  async saveListingMetrics(records: ListingSampleRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const timestamp = Date.now();

    await this.exec('BEGIN');
    try {
      for (const record of records) {
        await this.run(
          `INSERT INTO keyword_listing_metrics (
             keyword, sample_size, favorites_avg, favorites_median, review_velocity, price_median,
             price_iqr_over_median, payload, sampled_ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(keyword) DO UPDATE SET
             sample_size=excluded.sample_size,
             favorites_avg=excluded.favorites_avg,
             favorites_median=excluded.favorites_median,
             review_velocity=excluded.review_velocity,
             price_median=excluded.price_median,
             price_iqr_over_median=excluded.price_iqr_over_median,
             payload=excluded.payload,
             sampled_ts=excluded.sampled_ts`,
          [
            record.keyword,
            record.sampleSize,
            record.avgFavorites ?? null,
            record.medianFavorites ?? null,
            record.reviewVelocity ?? null,
            record.priceMedian ?? null,
            record.priceIqrOverMedian ?? null,
            toJson(record.payload),
            timestamp
          ]
        );
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async getListingMetrics(): Promise<ListingSampleRecord[]> {
    const rows = await this.all<{
      keyword: string;
      sample_size: number;
      favorites_avg: number | null;
      favorites_median: number | null;
      review_velocity: number | null;
      price_median: number | null;
      price_iqr_over_median: number | null;
      payload: string | null;
    }>(
      `SELECT keyword, sample_size, favorites_avg, favorites_median, review_velocity, price_median, price_iqr_over_median, payload
         FROM keyword_listing_metrics`
    );

    return rows.map((row) => ({
      keyword: row.keyword,
      sampleSize: row.sample_size,
      avgFavorites: row.favorites_avg,
      medianFavorites: row.favorites_median,
      reviewVelocity: row.review_velocity,
      priceMedian: row.price_median,
      priceIqrOverMedian: row.price_iqr_over_median,
      payload: parseJson<{ samples: unknown[] }>(row.payload ?? undefined)
    }));
  }

  async getListings(): Promise<ListingRowRecord[]> {
    const rows = await this.all<ListingRowRecord>(
      `SELECT keyword, position, page, listing_id as listingId, is_ad as isAd, title, shop, price, review_count as reviewCount,
              favorites, url FROM listings`
    );
    return rows;
  }

  async saveGoogleTrends(records: GoogleTrendsRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.exec('BEGIN');
    try {
      for (const record of records) {
        await this.run(
          `INSERT INTO trends_cache (keyword, window, avg_value, series_json, fetched_ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(keyword) DO UPDATE SET
             window=excluded.window,
             avg_value=excluded.avg_value,
             series_json=excluded.series_json,
             fetched_ts=excluded.fetched_ts`,
          [
            record.keyword,
            record.window,
            record.interest ?? null,
            toJson(record.series ?? []),
            record.fetchedAt
          ]
        );
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async getGoogleTrends(): Promise<GoogleTrendsRecord[]> {
    const rows = await this.all<{
      keyword: string;
      window: string;
      avg_value: number | null;
      series_json: string | null;
      fetched_ts: number;
    }>(`SELECT keyword, window, avg_value, series_json, fetched_ts FROM trends_cache`);

    return rows.map((row) => ({
      keyword: row.keyword,
      window: row.window,
      interest: row.avg_value,
      series: parseJson<number[]>(row.series_json),
      fetchedAt: row.fetched_ts
    }));
  }

  async saveOpportunitySnapshots(records: OpportunitySnapshotRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.exec('BEGIN');
    try {
      for (const record of records) {
        await this.run(
          `INSERT INTO search_snapshot (
             keyword, results_count, ad_ratio, dominance_index, price_median, price_iqr_over_median,
             favorites_avg, review_velocity, trends_avg, demand_score, competition_score, opportunity_score,
             components, computed_ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(keyword) DO UPDATE SET
             results_count=excluded.results_count,
             ad_ratio=excluded.ad_ratio,
             dominance_index=excluded.dominance_index,
             price_median=excluded.price_median,
             price_iqr_over_median=excluded.price_iqr_over_median,
             favorites_avg=excluded.favorites_avg,
             review_velocity=excluded.review_velocity,
             trends_avg=excluded.trends_avg,
             demand_score=excluded.demand_score,
             competition_score=excluded.competition_score,
             opportunity_score=excluded.opportunity_score,
             components=excluded.components,
             computed_ts=excluded.computed_ts`,
          [
            record.keyword,
            record.resultsCount ?? null,
            record.adRatio ?? null,
            record.dominanceIndex ?? null,
            record.priceMedian ?? null,
            record.priceIqrOverMedian ?? null,
            record.favoritesAvg ?? null,
            record.reviewVelocity ?? null,
            record.trendsAvg ?? null,
            record.demandScore ?? null,
            record.competitionScore ?? null,
            record.opportunityScore ?? null,
            toJson(record.components),
            record.computedTs
          ]
        );
      }
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async getOpportunitySnapshots(): Promise<OpportunitySnapshotRecord[]> {
    const rows = await this.all<{
      keyword: string;
      results_count: number | null;
      ad_ratio: number | null;
      dominance_index: number | null;
      price_median: number | null;
      price_iqr_over_median: number | null;
      favorites_avg: number | null;
      review_velocity: number | null;
      trends_avg: number | null;
      demand_score: number | null;
      competition_score: number | null;
      opportunity_score: number | null;
      components: string | null;
      computed_ts: number;
    }>(
      `SELECT keyword, results_count, ad_ratio, dominance_index, price_median, price_iqr_over_median, favorites_avg,
              review_velocity, trends_avg, demand_score, competition_score, opportunity_score, components, computed_ts
         FROM search_snapshot`
    );

    return rows.map((row) => ({
      keyword: row.keyword,
      resultsCount: row.results_count,
      adRatio: row.ad_ratio,
      dominanceIndex: row.dominance_index,
      priceMedian: row.price_median,
      priceIqrOverMedian: row.price_iqr_over_median,
      favoritesAvg: row.favorites_avg,
      reviewVelocity: row.review_velocity,
      trendsAvg: row.trends_avg,
      demandScore: row.demand_score,
      competitionScore: row.competition_score,
      opportunityScore: row.opportunity_score,
      components:
        parseJson<OpportunitySnapshotRecord['components']>(row.components ?? undefined) ?? {
          demand: { trends: 0, reviewVelocity: 0, favorites: 0 },
          competition: { resultsCount: 0, adRatio: 0, dominance: 0, priceDispersion: 0 }
        },
      computedTs: row.computed_ts
    }));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose, rejectClose) => {
      this.db.close((err) => {
        if (err) {
          rejectClose(err);
          return;
        }
        resolveClose();
      });
    });
  }
}
