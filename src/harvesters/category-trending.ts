import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type {
  CategoryTrendingDiscoveryConfig,
  PlaywrightConfig
} from '../config';
import { Logger } from '../utils/logger';
import { extractPhrases, normalizeKeyword } from '../utils/text';
import type { HarvestedKeywordRecord } from '../storage/types';

interface CategoryTrendingHarvesterDependencies {
  logger: Logger;
  config: CategoryTrendingDiscoveryConfig;
  playwrightConfig: PlaywrightConfig;
  stopwords: Set<string>;
}

export interface CategoryHarvestStats {
  urlsVisited: number;
  keywordsCollected: number;
  breakdown: Record<'category' | 'trending', number>;
  errors: number;
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

function pickUserAgent(playwrightConfig: PlaywrightConfig): string {
  const agents = playwrightConfig.user_agents;
  if (!agents || agents.length === 0) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  }
  if (agents.length === 1) {
    return agents[0];
  }
  const index = Math.floor(Math.random() * agents.length);
  return agents[index];
}

async function autoScroll(page: Page, attempts: number, waitMs: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.evaluate(() => {
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    });
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }
  }
}

async function extractListingTexts(page: Page) {
  return page.evaluate(() => {
    const results = {
      titles: [] as string[],
      tags: [] as string[]
    };

    const titleSelectors = [
      '[data-search-results] h3',
      'ol[data-search-results] h3',
      'li[data-listing-id] h3',
      'div[data-appears-component-name="SearchListing"] h3'
    ];

    const seenTitles = new Set<string>();
    for (const selector of titleSelectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const text = node.textContent ?? '';
        const trimmed = text.trim();
        if (trimmed && !seenTitles.has(trimmed)) {
          seenTitles.add(trimmed);
          results.titles.push(trimmed);
        }
      });
    }

    const tagSelectors = [
      '[data-ui="listing-tag"]',
      '[data-appears-component-name="ListingTag"]',
      '.listing-card__tag',
      '.wt-badge'
    ];

    const seenTags = new Set<string>();
    for (const selector of tagSelectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const text = node.textContent ?? '';
        const trimmed = text.trim();
        if (trimmed && !seenTags.has(trimmed)) {
          seenTags.add(trimmed);
          results.tags.push(trimmed);
        }
      });
    }

    return results;
  });
}

export class CategoryTrendingHarvester {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly deps: CategoryTrendingHarvesterDependencies) {}

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

  private async harvestFromUrl(url: string, source: 'category' | 'trending'): Promise<HarvestedKeywordRecord[]> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    const harvested: HarvestedKeywordRecord[] = [];

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await autoScroll(page, this.deps.config.scroll_attempts, this.deps.config.wait_between_scroll_ms);
      const extracted = await extractListingTexts(page);
      const pool = [...extracted.titles, ...extracted.tags];

      const seen = new Set<string>();
      for (const text of pool) {
        const candidates = extractPhrases(text, {
          stopwords: this.deps.stopwords,
          minTokens: this.deps.config.min_tokens,
          maxTokens: this.deps.config.max_tokens,
          minCharacters: 3
        });

        for (const candidate of candidates) {
          const normalized = normalizeKeyword(candidate);
          if (!normalized || seen.has(normalized)) {
            continue;
          }
          seen.add(normalized);
          harvested.push({
            keyword: normalized,
            source,
            url,
            context: {
              title: text,
              tags: extracted.tags.slice(0, 5)
            }
          });
          if (harvested.length >= this.deps.config.max_keywords_per_page) {
            return harvested;
          }
        }
      }
    } catch (error) {
      this.deps.logger.warn('Failed to harvest category/trending page', {
        url,
        source,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await page.close();
    }

    return harvested;
  }

  async run(): Promise<{ records: HarvestedKeywordRecord[]; stats: CategoryHarvestStats }> {
    const { config, logger } = this.deps;
    if (!config.enabled) {
      return {
        records: [],
        stats: {
          urlsVisited: 0,
          keywordsCollected: 0,
          breakdown: { category: 0, trending: 0 },
          errors: 0
        }
      };
    }

    const urls: Array<{ url: string; source: 'category' | 'trending' }> = [];
    config.category_urls.forEach((url) => urls.push({ url, source: 'category' }));
    config.trending_urls.forEach((url) => urls.push({ url, source: 'trending' }));

    const records: HarvestedKeywordRecord[] = [];
    const stats: CategoryHarvestStats = {
      urlsVisited: 0,
      keywordsCollected: 0,
      breakdown: { category: 0, trending: 0 },
      errors: 0
    };

    for (const entry of urls) {
      try {
        const harvested = await this.harvestFromUrl(entry.url, entry.source);
        records.push(...harvested);
        stats.urlsVisited += 1;
        stats.keywordsCollected += harvested.length;
        stats.breakdown[entry.source] += harvested.length;
        logger.debug('Harvested keywords from page', {
          url: entry.url,
          source: entry.source,
          keywordCount: harvested.length
        });
      } catch (error) {
        stats.errors += 1;
        logger.error('Failed to harvest keywords', {
          url: entry.url,
          source: entry.source,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await this.dispose();

    return { records, stats };
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
