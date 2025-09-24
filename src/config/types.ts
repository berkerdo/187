export interface RuntimeConfig {
  geo: string;
  discovery_budget: number;
  pages_to_sample: number;
  min_results: number;
  max_results: number;
  sleep_min_ms: number;
  sleep_max_ms: number;
  concurrency: number;
}

export interface WeightsConfig {
  review_velocity: number;
  favorites: number;
  ad_ratio: number;
  dominance: number;
  price_dispersion: number;
}

export interface ProxyConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
}

export interface PlaywrightConfig {
  headless: boolean;
  proxy: ProxyConfig;
  user_agents: string[];
}

export interface PathsConfig {
  data_dir: string;
  outputs_dir: string;
  db_file: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
}

export interface Settings {
  runtime: RuntimeConfig;
  weights: WeightsConfig;
  playwright: PlaywrightConfig;
  paths: PathsConfig;
  logging: LoggingConfig;
}

export interface EnvConfig {
  webUnblockerUrl?: string;
  webUnblockerAuth?: string;
  pytrendsTz?: string;
  pytrendsProxy?: string;
}
