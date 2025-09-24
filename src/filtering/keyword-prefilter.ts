import { request, type APIRequestContext } from 'playwright';

import type { PlaywrightConfig, PrefilterConfig, RuntimeConfig } from '../config';
import { Logger } from '../utils/logger';
import { normalizeKeyword, tokenize } from '../utils/text';
import type { KeywordCandidateRecord, PrefilteredKeywordRecord } from '../storage/types';

interface KeywordPrefilterDependencies {
  logger: Logger;
  config: PrefilterConfig;
  runtime: RuntimeConfig;
  playwrightConfig: PlaywrightConfig;
}

interface RejectReason {
  keyword: string;
  reasons: string[];
}

export interface PrefilterOutcome {
  passed: PrefilteredKeywordRecord[];
  rejected: RejectReason[];
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

function hasRequiredCharacters(keyword: string, requireLetter: boolean, allowNumbers: boolean): boolean {
  if (requireLetter && !/[a-z]/i.test(keyword)) {
    return false;
  }
  if (!allowNumbers && /\d/.test(keyword)) {
    return false;
  }
  return true;
}

function exceedsRepeatThreshold(keyword: string, threshold: number): boolean {
  if (threshold <= 0) {
    return false;
  }
  const pattern = new RegExp(`(.)\\1{${threshold},}`, 'i');
  return pattern.test(keyword);
}

function characterRatio(keyword: string): number {
  if (!keyword) {
    return 0;
  }
  const clean = keyword.replace(/\s+/g, '');
  if (clean.length === 0) {
    return 0;
  }
  const signal = clean.match(/[\p{L}\p{N}]/gu) ?? [];
  return signal.length / clean.length;
}

export class KeywordPrefilter {
  private requestContext: APIRequestContext | null = null;
  private readonly stopwords: Set<string>;
  private readonly forbiddenPatterns: RegExp[];

  constructor(private readonly deps: KeywordPrefilterDependencies) {
    this.stopwords = new Set(deps.config.stopwords.map((word) => word.toLowerCase()));
    this.forbiddenPatterns = deps.config.forbidden_patterns.map((pattern) => new RegExp(pattern, 'i'));
  }

  private async ensureRequestContext(): Promise<APIRequestContext> {
    if (this.requestContext) {
      return this.requestContext;
    }

    const proxy = buildProxyConfiguration(this.deps.playwrightConfig);
    this.requestContext = await request.newContext({
      baseURL: 'https://www.etsy.com',
      proxy,
      extraHTTPHeaders: {
        'User-Agent': this.deps.playwrightConfig.user_agents[0] ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    return this.requestContext;
  }

  private async estimateResultsCount(keyword: string): Promise<number | null> {
    if (!this.deps.config.head_request.enabled) {
      return null;
    }

    try {
      const context = await this.ensureRequestContext();
      const response = await context.get(`/search?q=${encodeURIComponent(keyword)}&explicit=1`, {
        timeout: this.deps.config.head_request.timeout_ms
      });
      if (!response.ok()) {
        this.deps.logger.debug('Prefilter head request returned non-OK status', {
          keyword,
          status: response.status()
        });
        return null;
      }

      const body = await response.text();
      const match = body.match(/([0-9,.]+)\s+results/i);
      if (!match) {
        return null;
      }
      const normalized = match[1].replace(/[,\.]/g, '');
      const parsed = Number.parseInt(normalized, 10);
      if (Number.isNaN(parsed)) {
        return null;
      }
      return parsed;
    } catch (error) {
      this.deps.logger.warn('Failed to estimate results count', {
        keyword,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private evaluateKeyword(candidate: KeywordCandidateRecord): { record: PrefilteredKeywordRecord | null; reject?: RejectReason } {
    const normalized = normalizeKeyword(candidate.keyword) ?? candidate.keyword;
    const reasons: string[] = [];
    const rejects: string[] = [];

    if (normalized.length < this.deps.config.min_length) {
      rejects.push('too_short');
    }
    if (normalized.length > this.deps.config.max_length) {
      rejects.push('too_long');
    }

    const tokens = tokenize(normalized);
    if (tokens.length < this.deps.config.min_tokens) {
      rejects.push('too_few_tokens');
    }
    if (tokens.length > this.deps.config.max_tokens) {
      rejects.push('too_many_tokens');
    }

    const onlyStopwords = tokens.length > 0 && tokens.every((token) => this.stopwords.has(token));
    if (onlyStopwords) {
      rejects.push('stopwords_only');
    }

    if (!hasRequiredCharacters(normalized, this.deps.config.require_letter, this.deps.config.allow_numbers)) {
      rejects.push('invalid_character_mix');
    }

    if (exceedsRepeatThreshold(normalized, this.deps.config.max_consecutive_repeat)) {
      rejects.push('repeating_characters');
    }

    const ratio = characterRatio(normalized);
    if (ratio < this.deps.config.min_character_ratio) {
      rejects.push('low_character_ratio');
    }

    for (const pattern of this.forbiddenPatterns) {
      if (pattern.test(normalized)) {
        rejects.push('forbidden_pattern');
        break;
      }
    }

    if (rejects.length > 0) {
      return {
        record: null,
        reject: { keyword: normalized, reasons: rejects }
      };
    }

    reasons.push('length_ok', 'tokens_ok', 'stopwords_ok');

    return {
      record: {
        keyword: normalized,
        length: normalized.length,
        tokens: tokens.length,
        sources: candidate.sources,
        reasons,
        resultsEstimate: null
      }
    };
  }

  async filter(candidates: KeywordCandidateRecord[]): Promise<PrefilterOutcome> {
    const passed: PrefilteredKeywordRecord[] = [];
    const rejected: RejectReason[] = [];

    for (const candidate of candidates) {
      const evaluation = this.evaluateKeyword(candidate);
      if (!evaluation.record) {
        if (evaluation.reject) {
          rejected.push(evaluation.reject);
        }
        continue;
      }

      const record = evaluation.record;
      const estimate = await this.estimateResultsCount(record.keyword);
      if (estimate !== null) {
        record.resultsEstimate = estimate;
        if (estimate < this.deps.runtime.min_results) {
          rejected.push({ keyword: record.keyword, reasons: ['below_min_results'] });
          continue;
        }
        if (estimate > this.deps.runtime.max_results) {
          rejected.push({ keyword: record.keyword, reasons: ['above_max_results'] });
          continue;
        }
        record.reasons.push(`results_estimate:${estimate}`);
      }

      passed.push(record);
    }

    if (this.requestContext) {
      await this.requestContext.dispose();
      this.requestContext = null;
    }

    return { passed, rejected };
  }
}
