import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadEnvConfig, loadSettings } from './config';
import { Logger } from './utils/logger';

function ensureDirectories(paths: string[]) {
  paths.forEach((path) => {
    const resolved = resolve(process.cwd(), path);
    mkdirSync(resolved, { recursive: true });
  });
}

function bootstrap() {
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
}

bootstrap();
