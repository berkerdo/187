import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { PlaywrightConfig, RuntimeConfig, SearchConfig } from '../config';
import { Logger } from '../utils/logger';
import { normalizeKeyword } from '../utils/text';
import type { SearchListingRecord, SearchResultRecord } from '../storage/types';

interface SearchResultsFetcherDependencies {
  logger: Logger;
  config: SearchConfig;
  runtime: RuntimeConfig;
  playwrightConfig: PlaywrightConfig;
}

interface ExtractedListingPayload {
  listings: SearchListingRecord[];
  topCards: string[];
  resultsCount: number | null;
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
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15';
  }
  if (pool.length === 1) {
    return pool[0];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

async function waitForResults(page: Page, config: SearchConfig): Promise<void> {
  for (const selector of config.result_selector_fallbacks) {
    try {
      await page.waitForSelector(selector, { timeout: config.wait_for_selector_ms });
      return;
    } catch (error) {
      // Continue trying fallbacks
    }
  }
}

async function extractListings(page: Page, pageNumber: number): Promise<ExtractedListingPayload> {
  return page.evaluate((pageIdx) => {
    const listings: SearchListingRecord[] = [];
    const seen = new Set<string>();

    const nodeList = document.querySelectorAll('[data-listing-id], li[data-palette-listing-id]');
    let position = pageIdx * 48;

    nodeList.forEach((node) => {
      const element = node as HTMLElement;
      const listingId = element.getAttribute('data-listing-id') || element.getAttribute('data-palette-listing-id');
      if (!listingId || seen.has(listingId)) {
        return;
      }

      seen.add(listingId);
      position += 1;

      const link = element.querySelector('a.listing-link, a[data-listing-id]') as HTMLAnchorElement | null;
      const titleNode = element.querySelector('h3');
      const shopNode = element.querySelector('[data-shop-name], .wt-text-caption');
      const priceNode = element.querySelector('[data-buy-box-listing-price] .currency-value, .currency-value');
      const reviewNode = element.querySelector('[data-review-count], [aria-label*="reviews"]');
      const favoriteNode = element.querySelector('[data-favorites-count]');

      const isAd = element.getAttribute('data-ad') === '1' ||
        element.classList.contains('wt-list-unstyled__item--ad') ||
        /ad/i.test(element.innerText.slice(0, 80));

      const parseNumber = (input: string | null | undefined): number | null => {
        if (!input) {
          return null;
        }
        const normalized = input.replace(/[^0-9.]/g, '');
        if (!normalized) {
          return null;
        }
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
      };

      const listing: SearchListingRecord = {
        position,
        page: pageIdx + 1,
        listingId,
        url: link?.href ?? undefined,
        title: titleNode?.textContent?.trim() ?? undefined,
        shop: shopNode?.textContent?.trim() ?? undefined,
        price: parseNumber(priceNode?.textContent ?? undefined),
        reviewCount: parseNumber(reviewNode?.textContent ?? undefined),
        favorites: parseNumber(favoriteNode?.getAttribute('data-favorites-count')),
        isAd
      };

      listings.push(listing);
    });

    const related = Array.from(
      document.querySelectorAll('section[aria-label*="Related"], section[aria-label*="Explore"] a')
    )
      .map((node) => node.textContent?.trim())
      .filter((text): text is string => Boolean(text));

    let resultsCount: number | null = null;
    const countNode = document.querySelector('[data-ui="results-count"], span[data-results-count]');
    const textSource = countNode?.textContent || document.body.innerText;
    if (textSource) {
      const match = textSource.match(/([0-9,.]+)\s+results/i);
      if (match) {
        const normalized = match[1].replace(/[,\.]/g, '');
        const parsed = Number.parseInt(normalized, 10);
        if (!Number.isNaN(parsed)) {
          resultsCount = parsed;
        }
      }
    }

    return {
      listings,
      topCards: related.slice(0, 20),
      resultsCount
    };
  }, pageNumber);
}

export class SearchResultsFetcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly deps: SearchResultsFetcherDependencies) {}

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

  async fetchKeyword(keyword: string): Promise<SearchResultRecord | null> {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) {
      return null;
    }

    const context = await this.ensureContext();
    const page = await context.newPage();
    const listings: SearchListingRecord[] = [];
    const htmlByPage: Record<number, string> = {};
    let topCards: string[] = [];
    let resultsCount: number | null = null;

    try {
      for (let pageIndex = 0; pageIndex < this.deps.config.pages; pageIndex += 1) {
        const url = `https://www.etsy.com/search?q=${encodeURIComponent(normalized)}&page=${pageIndex + 1}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await waitForResults(page, this.deps.config);

        const extracted = await extractListings(page, pageIndex);
        listings.push(...extracted.listings);
        if (topCards.length === 0) {
          topCards = extracted.topCards;
        }
        if (resultsCount === null && extracted.resultsCount !== null) {
          resultsCount = extracted.resultsCount;
        }

        if (this.deps.config.capture_html) {
          htmlByPage[pageIndex + 1] = await page.content();
        }

        if (pageIndex < this.deps.config.pages - 1 && this.deps.config.sleep_between_pages_ms > 0) {
          await page.waitForTimeout(this.deps.config.sleep_between_pages_ms);
        }
      }

      const adsCount = listings.filter((item) => item.isAd).length;
      return {
        keyword: normalized,
        resultsCount,
        adsCount,
        organicCount: listings.length - adsCount,
        adRatio: listings.length > 0 ? adsCount / listings.length : null,
        pagesFetched: this.deps.config.pages,
        topCards,
        listings,
        rawHtml: this.deps.config.capture_html ? htmlByPage : undefined,
        fetchedAt: Date.now()
      };
    } catch (error) {
      this.deps.logger.warn('Failed to fetch search results', {
        keyword: normalized,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    } finally {
      await page.close();
    }
  }

  async run(keywords: string[]): Promise<SearchResultRecord[]> {
    const results: SearchResultRecord[] = [];
    for (const keyword of keywords) {
      const record = await this.fetchKeyword(keyword);
      if (record) {
        results.push(record);
      }
    }

    await this.dispose();

    return results;
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
