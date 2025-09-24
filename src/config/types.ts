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

export interface AutocompleteSourceToggles {
  etsy: boolean;
  google: boolean;
}

export interface AutocompleteDiscoveryConfig {
  min_suggestions_to_expand: number;
  max_depth: number;
  alphabet: string[];
  initial_prefixes: string[];
  sleep_between_requests_ms: number;
  request_timeout_ms: number;
  max_suggestions_per_prefix: number;
  google_language: string;
  include_sources: AutocompleteSourceToggles;
}

export interface CategoryTrendingDiscoveryConfig {
  enabled: boolean;
  category_urls: string[];
  trending_urls: string[];
  max_pages_per_url: number;
  scroll_attempts: number;
  wait_between_scroll_ms: number;
  max_keywords_per_page: number;
  min_tokens: number;
  max_tokens: number;
}

export interface DiscoveryConfig {
  autocomplete: AutocompleteDiscoveryConfig;
  category_trending: CategoryTrendingDiscoveryConfig;
}

export interface PrefilterHeadRequestConfig {
  enabled: boolean;
  timeout_ms: number;
}

export interface PrefilterConfig {
  min_length: number;
  max_length: number;
  min_tokens: number;
  max_tokens: number;
  stopwords: string[];
  forbidden_patterns: string[];
  require_letter: boolean;
  allow_numbers: boolean;
  max_consecutive_repeat: number;
  min_character_ratio: number;
  head_request: PrefilterHeadRequestConfig;
}

export interface SearchConfig {
  pages: number;
  wait_for_selector_ms: number;
  sleep_between_pages_ms: number;
  capture_html: boolean;
  result_selector_fallbacks: string[];
}

export interface ListingSamplerConfig {
  per_keyword: number;
  wait_between_requests_ms: number;
  concurrency: number;
  review_window_days: number;
}

export interface TrendsConfig {
  enabled: boolean;
  lookback_months: number;
  geo: string;
  batch_size: number;
  sleep_between_batches_ms: number;
  python_path?: string;
}

export interface ExporterConfig {
  enabled: boolean;
  output_basename: string;
  top_n: number;
  explain_top_n: number;
  include_components: boolean;
}

export interface ObservabilityConfig {
  log_samples: number;
  summary_top_n: number;
  slow_threshold_ms: number;
}

export interface Settings {
  runtime: RuntimeConfig;
  weights: WeightsConfig;
  playwright: PlaywrightConfig;
  paths: PathsConfig;
  logging: LoggingConfig;
  discovery: DiscoveryConfig;
  filtering: PrefilterConfig;
  search: SearchConfig;
  sampling: ListingSamplerConfig;
  trends: TrendsConfig;
  exporter: ExporterConfig;
  observability: ObservabilityConfig;
}

export interface EnvConfig {
  webUnblockerUrl?: string;
  webUnblockerAuth?: string;
  pytrendsTz?: string;
  pytrendsProxy?: string;
  pythonPath?: string;
}
