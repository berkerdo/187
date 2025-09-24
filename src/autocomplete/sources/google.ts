import { APIRequestContext, request } from 'playwright';

import type { AutocompleteSuggestion, AutocompleteSource } from '../types';
import { Logger } from '../../utils/logger';
import type { ProxyConfig } from '../../config';

interface GoogleSourceOptions {
  logger: Logger;
  language: string;
  userAgent: string;
  proxy?: ProxyConfig;
  timeout: number;
  maxResults: number;
  region?: string;
}

const GOOGLE_ENDPOINT = 'https://suggestqueries.google.com/complete/search';

function buildProxyConfiguration(proxy?: ProxyConfig) {
  if (!proxy || !proxy.enabled || !proxy.url) {
    return undefined;
  }

  return {
    server: proxy.url,
    username: proxy.username || undefined,
    password: proxy.password || undefined
  };
}

function normalizeGoogleSuggestion(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, ' ').normalize('NFKC');
  if (normalized.length < 2) {
    return null;
  }

  return normalized;
}

class GoogleAutocompleteSource implements AutocompleteSource {
  readonly name = 'google';

  constructor(
    private readonly context: APIRequestContext,
    private readonly logger: Logger,
    private readonly language: string,
    private readonly maxResults: number,
    private readonly region?: string
  ) {}

  async fetchSuggestions(prefix: string): Promise<AutocompleteSuggestion[]> {
    const searchTerm = `etsy ${prefix}`.trim();
    const params = new URLSearchParams({
      client: 'chrome',
      hl: this.language,
      q: searchTerm
    });

    if (this.region) {
      params.set('gl', this.region);
    }

    try {
      const response = await this.context.get(`${GOOGLE_ENDPOINT}?${params.toString()}`, {
        headers: {
          Accept: 'application/json, text/plain, */*'
        }
      });

      if (!response.ok()) {
        this.logger.debug('Google autocomplete endpoint returned non-OK status', {
          status: response.status(),
          prefix
        });
        return [];
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        const textBody = await response.text();
        this.logger.warn('Google autocomplete response was not JSON', {
          prefix,
          snippet: textBody.slice(0, 120)
        });
        return [];
      }

      if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[1])) {
        this.logger.debug('Google autocomplete payload was in an unexpected format', {
          prefix
        });
        return [];
      }

      const rawSuggestions = payload[1] as unknown[];
      const suggestions: AutocompleteSuggestion[] = [];
      const seen = new Set<string>();

      for (const item of rawSuggestions) {
        if (typeof item !== 'string') {
          continue;
        }

        const normalized = normalizeGoogleSuggestion(item);
        if (!normalized) {
          continue;
        }

        const stripped = normalized.toLowerCase().startsWith('etsy ')
          ? normalized.slice(5)
          : normalized;
        const finalKeyword = normalizeGoogleSuggestion(stripped) ?? normalized;
        const lowered = finalKeyword.toLowerCase();

        if (seen.has(lowered)) {
          continue;
        }

        seen.add(lowered);
        suggestions.push({
          keyword: finalKeyword,
          source: this.name,
          prefix,
          rank: suggestions.length,
          payload: { original: item }
        });

        if (suggestions.length >= this.maxResults) {
          break;
        }
      }

      return suggestions;
    } catch (error) {
      this.logger.warn('Failed to fetch Google autocomplete suggestions', {
        prefix,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }
}

export async function createGoogleSource(options: GoogleSourceOptions): Promise<AutocompleteSource> {
  const context = await request.newContext({
    extraHTTPHeaders: {
      'User-Agent': options.userAgent,
      'Accept-Language': `${options.language},en;q=0.8`
    },
    timeout: options.timeout,
    proxy: buildProxyConfiguration(options.proxy)
  });

  return new GoogleAutocompleteSource(
    context,
    options.logger,
    options.language,
    options.maxResults,
    options.region
  );
}
