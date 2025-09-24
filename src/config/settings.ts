import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

import type { Settings } from './types';

let cachedSettings: Settings | null = null;

export function loadSettings(): Settings {
  if (cachedSettings) {
    return cachedSettings;
  }

  const configPath = resolve(process.cwd(), 'configs', 'settings.yaml');
  const fileContents = readFileSync(configPath, 'utf-8');
  const parsed = parse(fileContents) as Settings;

  cachedSettings = parsed;
  return parsed;
}
