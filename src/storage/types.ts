export interface KeywordCandidateRecord {
  keyword: string;
  sources: string[];
}

export type HarvestSourceType = 'category' | 'trending';

export interface HarvestedKeywordRecord {
  keyword: string;
  source: HarvestSourceType;
  url: string;
  context?: {
    title?: string;
    tags?: string[];
  };
}

export interface PrefilteredKeywordRecord {
  keyword: string;
  length: number;
  tokens: number;
  sources: string[];
  reasons: string[];
  resultsEstimate?: number | null;
}

export interface SearchListingRecord {
  position: number;
  page: number;
  listingId: string;
  url?: string;
  title?: string;
  shop?: string;
  price?: number | null;
  reviewCount?: number | null;
  favorites?: number | null;
  isAd: boolean;
}

export interface SearchResultRecord {
  keyword: string;
  resultsCount: number | null;
  adsCount: number;
  organicCount: number;
  adRatio: number | null;
  pagesFetched: number;
  topCards: string[];
  listings: SearchListingRecord[];
  rawHtml?: Record<number, string>;
  fetchedAt: number;
}

export interface ListingSampleDetail {
  listingId: string;
  url?: string;
  price?: number | null;
  favorites?: number | null;
  recentReviewTimestamps?: number[];
}

export interface ListingSampleRecord {
  keyword: string;
  sampleSize: number;
  avgFavorites: number | null;
  medianFavorites: number | null;
  reviewVelocity: number | null;
  priceMedian: number | null;
  priceIqrOverMedian: number | null;
  payload?: {
    samples: ListingSampleDetail[];
  };
}

export interface GoogleTrendsRecord {
  keyword: string;
  interest: number | null;
  window: string;
  series?: number[];
  fetchedAt: number;
}

export interface OpportunityComponentBreakdown {
  demand: {
    trends: number;
    reviewVelocity: number;
    favorites: number;
  };
  competition: {
    resultsCount: number;
    adRatio: number;
    dominance: number;
    priceDispersion: number;
  };
}

export interface OpportunitySnapshotRecord {
  keyword: string;
  resultsCount: number | null;
  adRatio: number | null;
  dominanceIndex: number | null;
  priceMedian: number | null;
  priceIqrOverMedian: number | null;
  favoritesAvg: number | null;
  reviewVelocity: number | null;
  trendsAvg: number | null;
  demandScore: number | null;
  competitionScore: number | null;
  opportunityScore: number | null;
  computedTs: number;
  components: OpportunityComponentBreakdown;
}

export interface SearchResultsMetadataRecord {
  keyword: string;
  resultsCount: number | null;
  adsCount: number;
  organicCount: number;
  adRatio: number | null;
  dominanceIndex: number | null;
  priceMedian: number | null;
  priceIqrOverMedian: number | null;
  topCards: string[];
  pagesFetched: number;
  fetchedAt: number;
}

export interface ListingRowRecord {
  keyword: string;
  position: number;
  page: number;
  listingId: string;
  isAd: number;
  title?: string | null;
  shop?: string | null;
  price?: number | null;
  reviewCount?: number | null;
  favorites?: number | null;
  url?: string | null;
}
