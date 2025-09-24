import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { ListingSamplerConfig, PlaywrightConfig } from '../config';
import { Logger } from '../utils/logger';
import { mean, median, iqr, sum } from '../utils/stats';
import type { ListingSampleDetail, ListingSampleRecord, SearchListingRecord, SearchResultRecord } from '../storage/types';

interface ListingSamplerDependencies {
  logger: Logger;
  config: ListingSamplerConfig;
  playwrightConfig: PlaywrightConfig;
}

interface PageSample {
  price: number | null;
  favorites: number | null;
  reviewTimestamps: number[];
}

function buildProxyConfiguration(config: PlaywrightConfig) {
  if (!config.proxy.enabled || !config.proxy.url) {
    return undefined;
  }

  return {
    server: config.proxy.url,
    username: config.proxy.username || undefined,
    password: config.proxy.password || undefined
  };
}

function pickUserAgent(config: PlaywrightConfig): string {
  const pool = config.user_agents;
  if (!pool || pool.length === 0) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  }
  if (pool.length === 1) {
    return pool[0];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

async function extractListingSample(page: Page): Promise<PageSample> {
  return page.evaluate(() => {
    const parseNumber = (value: string | null | undefined): number | null => {
      if (!value) {
        return null;
      }
      const normalized = value.replace(/[^0-9.]/g, '');
      if (!normalized) {
        return null;
      }
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const priceNode = document.querySelector('[data-buy-box-region] .wt-text-title-03, [data-buy-box-price] .currency-value, .wt-text-title-03 .currency-value');
    const favoritesNode = document.querySelector('[data-favorite-count], button[data-favorite-count], [data-favorites-count]');

    const reviewRootSelectors = ['#reviews', '[data-review-id]', '[data-appears-component-name="Review"]'];
    const reviewTimes: number[] = [];

    reviewRootSelectors.forEach((selector) => {
      document.querySelectorAll(`${selector} time[datetime]`).forEach((timeNode) => {
        const datetime = (timeNode as HTMLTimeElement).getAttribute('datetime');
        if (!datetime) {
          return;
        }
        const parsed = Date.parse(datetime);
        if (!Number.isNaN(parsed)) {
          reviewTimes.push(parsed);
        }
      });
    });

    if (reviewTimes.length === 0) {
      document.querySelectorAll('time[datetime]').forEach((timeNode) => {
        const datetime = (timeNode as HTMLTimeElement).getAttribute('datetime');
        if (!datetime) {
          return;
        }
        const parsed = Date.parse(datetime);
        if (!Number.isNaN(parsed)) {
          reviewTimes.push(parsed);
        }
      });
    }

    return {
      price: parseNumber(priceNode?.textContent ?? undefined),
      favorites: parseNumber(favoritesNode?.getAttribute('data-favorite-count') ?? favoritesNode?.textContent ?? undefined),
      reviewTimestamps: reviewTimes
    };
  });
}

export class ListingSampler {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly deps: ListingSamplerDependencies) {}

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    const proxy = buildProxyConfiguration(this.deps.playwrightConfig);
    this.browser = await chromium.launch({
      headless: this.deps.playwrightConfig.headless,
      proxy
    });

    this.context = await this.browser.newContext({
      userAgent: pickUserAgent(this.deps.playwrightConfig),
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    return this.context;
  }

  private chooseListings(result: SearchResultRecord): SearchListingRecord[] {
    const organic = result.listings.filter((listing) => !listing.isAd && listing.url);
    const ads = result.listings.filter((listing) => listing.isAd && listing.url);
    const combined = [...organic, ...ads];
    return combined.slice(0, this.deps.config.per_keyword);
  }

  private computeVelocity(samples: ListingSampleDetail[]): number | null {
    if (samples.length === 0) {
      return null;
    }
    const windowMs = this.deps.config.review_window_days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const counts: number[] = [];
    for (const sample of samples) {
      const timestamps = sample.recentReviewTimestamps ?? [];
      const filtered = timestamps.filter((timestamp) => now - timestamp <= windowMs);
      counts.push(filtered.length);
    }
    const total = sum(counts);
    if (total === 0) {
      return 0;
    }
    return total / this.deps.config.review_window_days;
  }

  private computePriceDispersion(prices: number[]): number | null {
    if (prices.length === 0) {
      return null;
    }
    const med = median(prices);
    if (med === null || med === 0) {
      return null;
    }
    const spread = iqr(prices);
    if (spread === null) {
      return null;
    }
    return spread / med;
  }

  async sample(result: SearchResultRecord): Promise<ListingSampleRecord | null> {
    const context = await this.ensureContext();
    const listings = this.chooseListings(result);
    if (listings.length === 0) {
      return null;
    }

    const samples: ListingSampleDetail[] = [];
    for (const listing of listings) {
      if (!listing.url) {
        continue;
      }
      const page = await context.newPage();
      try {
        await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const extracted = await extractListingSample(page);
        samples.push({
          listingId: listing.listingId,
          url: listing.url,
          price: extracted.price,
          favorites: extracted.favorites,
          recentReviewTimestamps: extracted.reviewTimestamps
        });
      } catch (error) {
        this.deps.logger.warn('Failed to sample listing page', {
          listingId: listing.listingId,
          url: listing.url,
          error: error instanceof Error ? error.message : String(error)
        });
        if (this.deps.config.wait_between_requests_ms > 0) {
          await page.waitForTimeout(this.deps.config.wait_between_requests_ms);
        }
      } finally {
        await page.close();
      }
    }

    if (samples.length === 0) {
      return null;
    }

    const priceValues = samples
      .map((sample) => sample.price)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const favoriteValues = samples
      .map((sample) => sample.favorites)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    const avgFavorites = mean(favoriteValues);
    const medianFavorites = median(favoriteValues);
    const priceMedian = median(priceValues);
    const priceDispersion = this.computePriceDispersion(priceValues);
    const reviewVelocity = this.computeVelocity(samples);

    return {
      keyword: result.keyword,
      sampleSize: samples.length,
      avgFavorites,
      medianFavorites,
      reviewVelocity,
      priceMedian,
      priceIqrOverMedian: priceDispersion,
      payload: {
        samples
      }
    };
  }

  async run(results: SearchResultRecord[]): Promise<ListingSampleRecord[]> {
    const metrics: ListingSampleRecord[] = [];
    for (const result of results) {
      const record = await this.sample(result);
      if (record) {
        metrics.push(record);
      }
    }

    await this.dispose();
    return metrics;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
