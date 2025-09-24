import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import type { EnvConfig, TrendsConfig } from '../config';
import { Logger } from '../utils/logger';
import type { GoogleTrendsRecord } from '../storage/types';

interface GoogleTrendsClientDependencies {
  logger: Logger;
  config: TrendsConfig;
  env: EnvConfig;
}

interface TrendsPayload {
  keyword: string;
  interest: number | null;
  series: number[];
}

function parseOutput(buffer: string): TrendsPayload[] {
  try {
    const parsed = JSON.parse(buffer) as { results?: TrendsPayload[] };
    return parsed.results ?? [];
  } catch (error) {
    return [];
  }
}

export class GoogleTrendsClient {
  constructor(private readonly deps: GoogleTrendsClientDependencies) {}

  private resolvePythonPath(): string {
    return this.deps.config.python_path || this.deps.env.pythonPath || 'python3';
  }

  async fetch(keywords: string[]): Promise<GoogleTrendsRecord[]> {
    if (!this.deps.config.enabled || keywords.length === 0) {
      return [];
    }

    const pythonPath = this.resolvePythonPath();
    const scriptPath = resolve(process.cwd(), 'python', 'trends_fetcher.py');

    return new Promise((resolvePromise) => {
      const child = spawn(pythonPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        this.deps.logger.error('Google Trends helper failed to start', {
          error: error instanceof Error ? error.message : String(error)
        });
        resolvePromise([]);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          this.deps.logger.warn('Google Trends helper exited with non-zero code', {
            code,
            stderr
          });
        }
        const payloads = parseOutput(stdout);
        const now = Date.now();
        const window = `today_${this.deps.config.lookback_months}m`;
        const records: GoogleTrendsRecord[] = payloads.map((entry) => ({
          keyword: entry.keyword,
          interest: entry.interest,
          series: entry.series,
          window,
          fetchedAt: now
        }));
        resolvePromise(records);
      });

      const message = JSON.stringify({
        keywords,
        lookbackMonths: this.deps.config.lookback_months,
        geo: this.deps.config.geo,
        batchSize: this.deps.config.batch_size,
        sleepBetweenBatchesMs: this.deps.config.sleep_between_batches_ms,
        tz: this.deps.env.pytrendsTz ?? 360,
        proxy: this.deps.env.pytrendsProxy ?? null
      });

      child.stdin.write(message);
      child.stdin.end();
    });
  }
}
