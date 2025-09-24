import { APIRequestContext, request } from 'playwright';

import type { AutocompleteSuggestion, AutocompleteSource } from '../types';
import { Logger } from '../../utils/logger';
import type { ProxyConfig } from '../../config';

interface EtsySourceOptions {
  logger: Logger;
  geo: string;
  userAgent: string;
  proxy?: ProxyConfig;
  timeout: number;
  maxResults: number;
}

interface Candidate {
  keyword: string;
  payload: unknown;
}

const CANDIDATE_KEY_PATTERN = /query|phrase|value|text|string|term|title/i;

function addCandidate(
  results: Candidate[],
  seen: Set<string>,
  value: string,
  raw: unknown,
  prefix: string,
  maxResults: number
) {
  if (results.length >= maxResults) {
    return;
  }

  const normalized = value.trim().replace(/\s+/g, ' ').normalize('NFKC');
  if (normalized.length < 2) {
    return;
  }

  const normalizedLower = normalized.toLowerCase();
  if (!normalizedLower.startsWith(prefix.toLowerCase())) {
    return;
  }

  if (!/[a-z0-9]/i.test(normalizedLower)) {
    return;
  }

  if (seen.has(normalizedLower)) {
    return;
  }

  seen.add(normalizedLower);
  results.push({ keyword: normalized, payload: raw });
}

function extractCandidates(payload: unknown, prefix: string, maxResults: number): Candidate[] {
  const results: Candidate[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [payload];

  while (stack.length > 0 && results.length < maxResults) {
    const current = stack.pop();
    if (current === undefined || current === null) {
      continue;
    }

    if (typeof current === 'string') {
      addCandidate(results, seen, current, current, prefix, maxResults);
      continue;
    }

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push(current[i]);
      }
      continue;
    }

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'string' && CANDIDATE_KEY_PATTERN.test(key)) {
          addCandidate(results, seen, value, record, prefix, maxResults);
        } else if (typeof value === 'string' && CANDIDATE_KEY_PATTERN.test(value)) {
          addCandidate(results, seen, value, record, prefix, maxResults);
        } else if (value && typeof value === 'object') {
          stack.push(value);
        } else if (Array.isArray(value)) {
          stack.push(value);
        }
      }
    }
  }

  return results.slice(0, maxResults);
}

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

class EtsyAutocompleteSource implements AutocompleteSource {
  readonly name = 'etsy';

  constructor(
    private readonly context: APIRequestContext,
    private readonly logger: Logger,
    private readonly geo: string,
    private readonly maxResults: number
  ) {}

  async fetchSuggestions(prefix: string): Promise<AutocompleteSuggestion[]> {
    const endpoints = [
      `/api/v3/ajax/public/SearchAutoComplete?explicit=1&limit=${this.maxResults}&prefix=${encodeURIComponent(prefix)}&region=${encodeURIComponent(this.geo)}`,
      `/api/v3/ajax/public/SearchTypeahead?limit=${this.maxResults}&prefix=${encodeURIComponent(prefix)}&region=${encodeURIComponent(this.geo)}`,
      `/suggestions_ajax.php?search_type=all&v=1&limit=${this.maxResults}&q=${encodeURIComponent(prefix)}`
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await this.context.get(endpoint, {
          headers: {
            Accept: 'application/json, text/plain, */*'
          }
        });
        if (!response.ok()) {
          this.logger.debug('Etsy autocomplete endpoint returned non-OK status', {
            status: response.status(),
            prefix,
            endpoint
          });
          continue;
        }

        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch (error) {
          const textBody = await response.text();
          this.logger.warn('Etsy autocomplete response was not JSON', {
            prefix,
            endpoint,
            snippet: textBody.slice(0, 120)
          });
          continue;
        }

        const candidates = extractCandidates(payload, prefix, this.maxResults);
        if (candidates.length === 0) {
          continue;
        }

        return candidates.map((candidate, index) => ({
          keyword: candidate.keyword,
          source: this.name,
          prefix,
          rank: index,
          payload: candidate.payload
        }));
      } catch (error) {
        this.logger.warn('Failed to fetch Etsy autocomplete suggestions', {
          prefix,
          endpoint,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return [];
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }
}

export async function createEtsySource(options: EtsySourceOptions): Promise<AutocompleteSource> {
  const context = await request.newContext({
    baseURL: 'https://www.etsy.com',
    extraHTTPHeaders: {
      'User-Agent': options.userAgent,
      'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: options.timeout,
    proxy: buildProxyConfiguration(options.proxy)
  });

  return new EtsyAutocompleteSource(context, options.logger, options.geo, options.maxResults);
}
