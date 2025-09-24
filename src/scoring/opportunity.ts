import type { WeightsConfig } from '../config';
import type { KeywordStore } from '../storage/keyword-store';
import type {
  GoogleTrendsRecord,
  ListingSampleRecord,
  OpportunitySnapshotRecord,
  SearchResultsMetadataRecord
} from '../storage/types';
import { Logger } from '../utils/logger';
import { robustNormalize } from '../utils/stats';

interface OpportunityScorerDependencies {
  logger: Logger;
  weights: WeightsConfig;
  store: KeywordStore;
}

interface AggregatedMetrics {
  metadata?: SearchResultsMetadataRecord;
  listing?: ListingSampleRecord;
  trends?: GoogleTrendsRecord;
}

function collectSeries(records: Array<number | null | undefined>): number[] {
  return records.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

export class OpportunityScorer {
  constructor(private readonly deps: OpportunityScorerDependencies) {}

  private buildAggregatedMetrics(
    metadata: SearchResultsMetadataRecord[],
    listings: ListingSampleRecord[],
    trends: GoogleTrendsRecord[]
  ): Map<string, AggregatedMetrics> {
    const map = new Map<string, AggregatedMetrics>();

    metadata.forEach((record) => {
      map.set(record.keyword, { metadata: record });
    });

    listings.forEach((record) => {
      const existing = map.get(record.keyword) ?? {};
      existing.listing = record;
      map.set(record.keyword, existing);
    });

    trends.forEach((record) => {
      const existing = map.get(record.keyword) ?? {};
      existing.trends = record;
      map.set(record.keyword, existing);
    });

    return map;
  }

  private computeSnapshot(keyword: string, metrics: AggregatedMetrics, series: {
    logResults: number[];
    adRatio: number[];
    dominance: number[];
    priceDispersion: number[];
    reviewVelocity: number[];
    favorites: number[];
    trends: number[];
  }): OpportunitySnapshotRecord | null {
    const resultsCount = metrics.metadata?.resultsCount ?? null;
    const logResults = resultsCount !== null ? Math.log1p(resultsCount) : null;
    const adRatio = metrics.metadata?.adRatio ?? null;
    const dominance = metrics.metadata?.dominanceIndex ?? null;
    const priceDispersion = metrics.listing?.priceIqrOverMedian ?? metrics.metadata?.priceIqrOverMedian ?? null;
    const favoritesAvg = metrics.listing?.avgFavorites ?? metrics.listing?.medianFavorites ?? null;
    const reviewVelocity = metrics.listing?.reviewVelocity ?? null;
    const trendsAvg = metrics.trends?.interest ?? null;
    const priceMedian = metrics.listing?.priceMedian ?? metrics.metadata?.priceMedian ?? null;

    const demandComponents = {
      trends: trendsAvg !== null ? robustNormalize(trendsAvg, series.trends) : 0,
      reviewVelocity: reviewVelocity !== null ? robustNormalize(reviewVelocity, series.reviewVelocity) : 0,
      favorites: favoritesAvg !== null ? robustNormalize(favoritesAvg, series.favorites) : 0
    };

    const competitionComponents = {
      resultsCount: logResults !== null ? robustNormalize(logResults, series.logResults) : 0,
      adRatio: adRatio !== null ? robustNormalize(adRatio, series.adRatio) : 0,
      dominance: dominance !== null ? robustNormalize(dominance, series.dominance) : 0,
      priceDispersion: priceDispersion !== null ? robustNormalize(priceDispersion, series.priceDispersion) : 0
    };

    const demandScore =
      demandComponents.trends +
      this.deps.weights.review_velocity * demandComponents.reviewVelocity +
      this.deps.weights.favorites * demandComponents.favorites;

    const competitionScore =
      competitionComponents.resultsCount +
      this.deps.weights.ad_ratio * competitionComponents.adRatio +
      this.deps.weights.dominance * competitionComponents.dominance +
      this.deps.weights.price_dispersion * competitionComponents.priceDispersion;

    const opportunityScore = demandScore / (1 + Math.max(0, competitionScore));

    return {
      keyword,
      resultsCount,
      adRatio,
      dominanceIndex: dominance,
      priceMedian,
      priceIqrOverMedian: priceDispersion,
      favoritesAvg,
      reviewVelocity,
      trendsAvg,
      demandScore,
      competitionScore,
      opportunityScore,
      computedTs: Date.now(),
      components: {
        demand: {
          trends: demandComponents.trends,
          reviewVelocity: this.deps.weights.review_velocity * demandComponents.reviewVelocity,
          favorites: this.deps.weights.favorites * demandComponents.favorites
        },
        competition: {
          resultsCount: competitionComponents.resultsCount,
          adRatio: this.deps.weights.ad_ratio * competitionComponents.adRatio,
          dominance: this.deps.weights.dominance * competitionComponents.dominance,
          priceDispersion: this.deps.weights.price_dispersion * competitionComponents.priceDispersion
        }
      }
    };
  }

  async compute(): Promise<OpportunitySnapshotRecord[]> {
    const [metadata, listings, trends] = await Promise.all([
      this.deps.store.getSearchResultsMetadata(),
      this.deps.store.getListingMetrics(),
      this.deps.store.getGoogleTrends()
    ]);

    const aggregated = this.buildAggregatedMetrics(metadata, listings, trends);

    const series = {
      logResults: collectSeries(metadata.map((record) => (record.resultsCount !== null ? Math.log1p(record.resultsCount) : null))),
      adRatio: collectSeries(metadata.map((record) => record.adRatio)),
      dominance: collectSeries(metadata.map((record) => record.dominanceIndex)),
      priceDispersion: collectSeries(
        listings.map((record) => record.priceIqrOverMedian ?? null).concat(metadata.map((record) => record.priceIqrOverMedian ?? null))
      ),
      reviewVelocity: collectSeries(listings.map((record) => record.reviewVelocity)),
      favorites: collectSeries(listings.map((record) => record.avgFavorites ?? record.medianFavorites ?? null)),
      trends: collectSeries(trends.map((record) => record.interest))
    };

    const snapshots: OpportunitySnapshotRecord[] = [];

    for (const [keyword, metrics] of aggregated.entries()) {
      const snapshot = this.computeSnapshot(keyword, metrics, series);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    snapshots.sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0));

    if (snapshots.length === 0) {
      this.deps.logger.warn('No opportunity snapshots were computed; missing metrics may have prevented scoring');
    }

    return snapshots;
  }
}
