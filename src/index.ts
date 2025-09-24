import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadEnvConfig, loadSettings } from './config';
import { Logger } from './utils/logger';
import { KeywordStore } from './storage/keyword-store';
import { AutocompleteEnumerator } from './autocomplete';
import { CategoryTrendingHarvester } from './harvesters';
import { KeywordPrefilter } from './filtering';
import { ListingSampler, SearchResultsFetcher } from './search';
import { GoogleTrendsClient } from './trends';
import { OpportunityScorer } from './scoring';
import { CsvExporter } from './export';

function ensureDirectories(paths: string[]) {
  paths.forEach((path) => {
    const resolved = resolve(process.cwd(), path);
    mkdirSync(resolved, { recursive: true });
  });
}

function summarizeTopKeywords(keywords: string[], limit: number): string[] {
  return keywords.slice(0, limit).map((keyword, index) => `${index + 1}. ${keyword}`);
}

async function bootstrap() {
  const settings = loadSettings();
  const env = loadEnvConfig();

  ensureDirectories([settings.paths.data_dir, settings.paths.outputs_dir]);

  const logger = new Logger({ level: settings.logging.level, format: settings.logging.format });

  logger.info('Etsy keyword discovery pipeline bootstrap complete', {
    geo: settings.runtime.geo,
    discoveryBudget: settings.runtime.discovery_budget,
    pagesToSample: settings.runtime.pages_to_sample,
    minResults: settings.runtime.min_results,
    maxResults: settings.runtime.max_results,
    sleepRange: [settings.runtime.sleep_min_ms, settings.runtime.sleep_max_ms],
    concurrency: settings.runtime.concurrency,
    hasProxyConfigured: Boolean(env.webUnblockerUrl)
  });

  let store: KeywordStore | null = null;

  try {
    store = await KeywordStore.initialize(settings.paths.db_file, logger);

    const enumerator = new AutocompleteEnumerator({
      logger,
      discoveryConfig: settings.discovery.autocomplete,
      runtimeConfig: settings.runtime,
      playwrightConfig: settings.playwright,
      store
    });

    logger.info('Starting autocomplete enumeration', {
      alphabetSize: settings.discovery.autocomplete.alphabet.length,
      maxDepth: settings.discovery.autocomplete.max_depth,
      minSuggestionsToExpand: settings.discovery.autocomplete.min_suggestions_to_expand,
      enabledSources: settings.discovery.autocomplete.include_sources,
      requestTimeoutMs: settings.discovery.autocomplete.request_timeout_ms
    });

    const autocompleteStats = await enumerator.run();

    logger.info('Autocomplete enumeration finished', {
      prefixesProcessed: autocompleteStats.totalPrefixesProcessed,
      uniqueKeywords: autocompleteStats.uniqueKeywordsDiscovered,
      suggestionsPersisted: autocompleteStats.totalSuggestionsPersisted,
      sourceBreakdown: autocompleteStats.sourceBreakdown,
      exhaustedBudget: autocompleteStats.exhaustedBudget
    });

    const stopwords = new Set(settings.filtering.stopwords.map((word) => word.toLowerCase()));
    const harvester = new CategoryTrendingHarvester({
      logger,
      config: settings.discovery.category_trending,
      playwrightConfig: settings.playwright,
      stopwords
    });

    const harvestStart = Date.now();
    const harvestResult = await harvester.run();
    if (harvestResult.records.length > 0) {
      const saved = await store.saveHarvestedKeywords(harvestResult.records);
      logger.info('Category/trending harvesting complete', {
        urlsVisited: harvestResult.stats.urlsVisited,
        keywordsCollected: harvestResult.stats.keywordsCollected,
        breakdown: harvestResult.stats.breakdown,
        persisted: saved,
        durationMs: Date.now() - harvestStart
      });
    } else {
      logger.info('Category/trending harvesting skipped or yielded no results', {
        enabled: settings.discovery.category_trending.enabled
      });
    }

    const candidates = await store.getKeywordCandidates();
    logger.info('Total candidate keywords discovered', {
      candidates: candidates.length
    });

    const prefilter = new KeywordPrefilter({
      logger,
      config: settings.filtering,
      runtime: settings.runtime,
      playwrightConfig: settings.playwright
    });

    const prefilterStart = Date.now();
    const prefilterOutcome = await prefilter.filter(candidates);
    await store.savePrefilteredKeywords(prefilterOutcome.passed);

    if (prefilterOutcome.rejected.length > 0) {
      logger.debug('Sample of rejected keywords', {
        sample: prefilterOutcome.rejected.slice(0, settings.observability.log_samples)
      });
    }

    logger.info('Keyword prefilter complete', {
      passed: prefilterOutcome.passed.length,
      rejected: prefilterOutcome.rejected.length,
      durationMs: Date.now() - prefilterStart
    });

    const filteredKeywords = prefilterOutcome.passed.map((record) => record.keyword);
    if (filteredKeywords.length === 0) {
      logger.warn('No keywords passed prefilter; aborting downstream pipeline stages');
      return;
    }

    const searchFetcher = new SearchResultsFetcher({
      logger,
      config: settings.search,
      runtime: settings.runtime,
      playwrightConfig: settings.playwright
    });

    const searchStart = Date.now();
    const searchResults = await searchFetcher.run(filteredKeywords);
    await store.saveSearchResults(searchResults);

    logger.info('Search results fetching complete', {
      keywordsProcessed: searchResults.length,
      listingsPersisted: searchResults.reduce((acc, result) => acc + result.listings.length, 0),
      durationMs: Date.now() - searchStart
    });

    const sampler = new ListingSampler({
      logger,
      config: settings.sampling,
      playwrightConfig: settings.playwright
    });

    const samplingStart = Date.now();
    const listingMetrics = await sampler.run(searchResults);
    await store.saveListingMetrics(listingMetrics);

    logger.info('Listing sampling complete', {
      keywordsSampled: listingMetrics.length,
      averageSampleSize: listingMetrics.length > 0
        ? listingMetrics.reduce((acc, metric) => acc + metric.sampleSize, 0) / listingMetrics.length
        : 0,
      durationMs: Date.now() - samplingStart
    });

    const trendsClient = new GoogleTrendsClient({
      logger,
      config: settings.trends,
      env
    });

    const trendsStart = Date.now();
    const trendsRecords = await trendsClient.fetch(filteredKeywords);
    await store.saveGoogleTrends(trendsRecords);

    logger.info('Google Trends integration complete', {
      keywordsQueried: trendsRecords.length,
      durationMs: Date.now() - trendsStart
    });

    const scorer = new OpportunityScorer({
      logger,
      weights: settings.weights,
      store
    });

    const scoringStart = Date.now();
    const snapshots = await scorer.compute();
    await store.saveOpportunitySnapshots(snapshots);

    logger.info('Opportunity scoring complete', {
      keywordsScored: snapshots.length,
      topKeywords: summarizeTopKeywords(
        snapshots.map((snapshot) => snapshot.keyword),
        settings.observability.summary_top_n
      ),
      durationMs: Date.now() - scoringStart
    });

    const exporter = new CsvExporter({
      logger,
      config: settings.exporter,
      outputDir: settings.paths.outputs_dir
    });

    const exportPath = exporter.export(snapshots);
    if (exportPath) {
      logger.info('CSV export ready', {
        outputPath: exportPath
      });
    }
  } catch (error) {
    logger.error('Pipeline execution failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    if (store) {
      await store.close().catch((error) => {
        logger.warn('Failed to close keyword store cleanly', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', error);
  process.exitCode = 1;
});
