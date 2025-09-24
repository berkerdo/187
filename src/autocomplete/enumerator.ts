import { randomInt } from 'node:crypto';

import type {
  AutocompleteEnumeratorDependencies,
  AutocompleteRunStats,
  AutocompleteSource,
  AutocompleteSuggestion,
  AutocompleteSourceName
} from './types';
import { createEtsySource, createGoogleSource } from './sources';

function sanitizeKeyword(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const collapsed = trimmed.replace(/\s+/g, ' ');
  const normalized = collapsed.normalize('NFKC').toLowerCase();
  return normalized.length >= 2 ? normalized : null;
}

function pickRandom<T>(values: T[]): T | undefined {
  if (values.length === 0) {
    return undefined;
  }

  if (values.length === 1) {
    return values[0];
  }

  const index = randomInt(values.length);
  return values[index];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function initializeQueue(initialPrefixes: string[], alphabet: string[]): string[] {
  const queue: string[] = [];
  const seeds = initialPrefixes.length > 0 ? initialPrefixes : alphabet;

  for (const seed of seeds) {
    const normalizedSeed = seed.trim();
    if (normalizedSeed.length === 0) {
      continue;
    }
    queue.push(normalizedSeed.toLowerCase());
  }

  return queue;
}

function ensureSourceBreakdown(): Record<AutocompleteSourceName, number> {
  return {
    etsy: 0,
    google: 0
  };
}

export class AutocompleteEnumerator {
  constructor(private readonly deps: AutocompleteEnumeratorDependencies) {}

  private async buildSources(): Promise<AutocompleteSource[]> {
    const { discoveryConfig, runtimeConfig, playwrightConfig, logger } = this.deps;
    const userAgent = pickRandom(playwrightConfig.user_agents) ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

    const sources: AutocompleteSource[] = [];
    const toggles = discoveryConfig.include_sources;

    if (toggles.etsy) {
      sources.push(
        await createEtsySource({
          logger,
          geo: runtimeConfig.geo || 'US',
          userAgent,
          proxy: playwrightConfig.proxy,
          timeout: discoveryConfig.request_timeout_ms,
          maxResults: discoveryConfig.max_suggestions_per_prefix
        })
      );
    }

    if (toggles.google) {
      sources.push(
        await createGoogleSource({
          logger,
          language: discoveryConfig.google_language || 'en',
          userAgent,
          proxy: playwrightConfig.proxy,
          timeout: discoveryConfig.request_timeout_ms,
          maxResults: discoveryConfig.max_suggestions_per_prefix,
          region: runtimeConfig.geo || undefined
        })
      );
    }

    if (sources.length === 0) {
      this.deps.logger.warn('No autocomplete sources were enabled; enumeration will be skipped.');
    }

    return sources;
  }

  async run(): Promise<AutocompleteRunStats> {
    const { discoveryConfig, runtimeConfig, logger, store } = this.deps;
    const sources = await this.buildSources();

    if (sources.length === 0) {
      return {
        totalPrefixesProcessed: 0,
        uniqueKeywordsDiscovered: 0,
        totalSuggestionsPersisted: 0,
        sourceBreakdown: ensureSourceBreakdown(),
        exhaustedBudget: false
      };
    }

    const alphabet = discoveryConfig.alphabet.length > 0 ? discoveryConfig.alphabet : 'abcdefghijklmnopqrstuvwxyz'.split('');
    const queue = initializeQueue(discoveryConfig.initial_prefixes, alphabet);
    const visited = new Set(queue);

    const uniqueKeywords = new Set<string>();
    const sourceBreakdown = ensureSourceBreakdown();
    let totalPersisted = 0;
    let processedPrefixes = 0;
    const persistedCombinations = new Set<string>();

    const budget = runtimeConfig.discovery_budget;
    const maxDepth = Math.max(1, discoveryConfig.max_depth);
    const minSuggestionsToExpand = Math.max(1, discoveryConfig.min_suggestions_to_expand);
    const delay = Math.max(0, discoveryConfig.sleep_between_requests_ms);

    try {
      while (queue.length > 0) {
        const prefix = queue.shift();
        if (!prefix) {
          continue;
        }

        processedPrefixes += 1;
        const prefixSuggestions: AutocompleteSuggestion[] = [];
        const prefixUnique = new Set<string>();
        const perSourceSeen = new Map<AutocompleteSourceName, Set<string>>();

        for (const source of sources) {
          const seenForSource = perSourceSeen.get(source.name) ?? new Set<string>();
          perSourceSeen.set(source.name, seenForSource);

          let suggestions: AutocompleteSuggestion[] = [];
          try {
            suggestions = await source.fetchSuggestions(prefix);
          } catch (error) {
            logger.warn('Autocomplete source threw an error while fetching suggestions', {
              source: source.name,
              prefix,
              error: error instanceof Error ? error.message : String(error)
            });
            continue;
          }

          for (const suggestion of suggestions) {
            const normalized = sanitizeKeyword(suggestion.keyword);
            if (!normalized) {
              continue;
            }

            if (seenForSource.has(normalized)) {
              continue;
            }

            const isNewKeyword = !uniqueKeywords.has(normalized);
            if (isNewKeyword && uniqueKeywords.size >= budget) {
              continue;
            }

            seenForSource.add(normalized);
            uniqueKeywords.add(normalized);
            prefixUnique.add(normalized);

            const combinationKey = `${suggestion.source}:${normalized}`;
            if (persistedCombinations.has(combinationKey)) {
              continue;
            }

            persistedCombinations.add(combinationKey);

            const payload = suggestion.payload ?? { original: suggestion.keyword };
            prefixSuggestions.push({
              keyword: normalized,
              source: suggestion.source,
              prefix,
              rank: suggestion.rank,
              payload
            });
            sourceBreakdown[source.name] = (sourceBreakdown[source.name] ?? 0) + 1;
          }
        }

        if (prefixSuggestions.length > 0) {
          await store.saveSuggestions(prefixSuggestions);
          totalPersisted += prefixSuggestions.length;
        }

        if (
          prefix.length < maxDepth &&
          prefixUnique.size >= minSuggestionsToExpand &&
          uniqueKeywords.size < budget
        ) {
          for (const letter of alphabet) {
            const fragment = letter.trim().toLowerCase();
            if (!fragment) {
              continue;
            }
            const candidate = `${prefix}${fragment}`;
            if (visited.has(candidate)) {
              continue;
            }
            visited.add(candidate);
            queue.push(candidate);
          }
        }

        if (uniqueKeywords.size >= budget) {
          logger.info('Discovery budget reached; stopping prefix exploration', {
            budget,
            processedPrefixes
          });
          break;
        }

        if (delay > 0) {
          await sleep(delay);
        }
      }
    } finally {
      await Promise.all(
        sources.map(async (source) => {
          try {
            await source.dispose();
          } catch (error) {
            logger.warn('Failed to dispose autocomplete source', {
              source: source.name,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })
      );
    }

    return {
      totalPrefixesProcessed: processedPrefixes,
      uniqueKeywordsDiscovered: uniqueKeywords.size,
      totalSuggestionsPersisted: totalPersisted,
      sourceBreakdown,
      exhaustedBudget: uniqueKeywords.size >= budget
    };
  }
}
