import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import type { EnvConfig } from './types';

let cachedEnv: EnvConfig | null = null;

export function loadEnvConfig(): EnvConfig {
  if (cachedEnv) {
    return cachedEnv;
  }

  loadEnv({ path: resolve(process.cwd(), '.env') });

  cachedEnv = {
    webUnblockerUrl: process.env.WEB_UNBLOCKER_URL,
    webUnblockerAuth: process.env.WEB_UNBLOCKER_AUTH,
    pytrendsTz: process.env.PYTRENDS_TZ,
    pytrendsProxy: process.env.PYTRENDS_PROXY,
    pythonPath: process.env.PYTHON_PATH
  };

  return cachedEnv;
}
