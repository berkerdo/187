import type { AutocompleteDiscoveryConfig, PlaywrightConfig, RuntimeConfig } from '../config';
import type { Logger } from '../utils/logger';
import type { KeywordStore } from '../storage/keyword-store';

export type AutocompleteSourceName = 'etsy' | 'google';

export interface AutocompleteSuggestion {
  keyword: string;
  source: AutocompleteSourceName;
  prefix: string;
  rank: number;
  payload?: unknown;
}

export interface AutocompleteSource {
  readonly name: AutocompleteSourceName;
  fetchSuggestions(prefix: string): Promise<AutocompleteSuggestion[]>;
  dispose(): Promise<void>;
}

export interface AutocompleteEnumeratorDependencies {
  logger: Logger;
  discoveryConfig: AutocompleteDiscoveryConfig;
  runtimeConfig: RuntimeConfig;
  playwrightConfig: PlaywrightConfig;
  store: KeywordStore;
}

export interface AutocompleteRunStats {
  totalPrefixesProcessed: number;
  uniqueKeywordsDiscovered: number;
  totalSuggestionsPersisted: number;
  sourceBreakdown: Record<AutocompleteSourceName, number>;
  exhaustedBudget: boolean;
}
