import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ExporterConfig } from '../config';
import type { OpportunitySnapshotRecord } from '../storage/types';
import { Logger } from '../utils/logger';

interface CsvExporterDependencies {
  logger: Logger;
  config: ExporterConfig;
  outputDir: string;
}

function formatNumber(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '';
  }
  return value.toFixed(digits);
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildExplanation(snapshot: OpportunitySnapshotRecord): string {
  const positives: string[] = [];
  const negatives: string[] = [];

  if (snapshot.components.demand.trends > 0.5) {
    positives.push('strong Google Trends momentum');
  }
  if (snapshot.components.demand.reviewVelocity > 0.5) {
    positives.push('fast review velocity');
  }
  if (snapshot.components.demand.favorites > 0.5) {
    positives.push('high shopper engagement');
  }

  if (snapshot.components.competition.resultsCount < 0) {
    positives.push('low result counts');
  } else if (snapshot.components.competition.resultsCount > 0.5) {
    negatives.push('crowded query');
  }

  if (snapshot.components.competition.adRatio < 0) {
    positives.push('few ads visible');
  } else if (snapshot.components.competition.adRatio > 0.5) {
    negatives.push('heavy ad presence');
  }

  if (snapshot.components.competition.dominance < 0) {
    positives.push('diverse sellers');
  } else if (snapshot.components.competition.dominance > 0.5) {
    negatives.push('dominant shops on page 1');
  }

  if (snapshot.components.competition.priceDispersion < 0) {
    positives.push('stable pricing landscape');
  } else if (snapshot.components.competition.priceDispersion > 0.5) {
    negatives.push('wide price dispersion');
  }

  const summary: string[] = [];
  if (positives.length > 0) {
    summary.push(`Pros: ${positives.join('; ')}`);
  }
  if (negatives.length > 0) {
    summary.push(`Watchouts: ${negatives.join('; ')}`);
  }

  return summary.join(' | ');
}

export class CsvExporter {
  constructor(private readonly deps: CsvExporterDependencies) {}

  export(snapshots: OpportunitySnapshotRecord[]): string | null {
    if (!this.deps.config.enabled || snapshots.length === 0) {
      return null;
    }

    const top = snapshots.slice(0, this.deps.config.top_n);
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `${this.deps.config.output_basename}_${stamp}.csv`;
    const outputPath = resolve(this.deps.outputDir, fileName);

    const header = [
      'keyword',
      'opportunity_score',
      'demand_score',
      'competition_score',
      'results_count',
      'ad_ratio',
      'dominance_index',
      'price_median',
      'price_iqr_over_median',
      'favorites_avg',
      'review_velocity',
      'trends_avg',
      'why_it_ranks'
    ];

    const rows = [header.join(',')];

    top.forEach((snapshot, index) => {
      const explanation = index < this.deps.config.explain_top_n ? buildExplanation(snapshot) : '';
      const row = [
        escapeCsv(snapshot.keyword),
        formatNumber(snapshot.opportunityScore),
        formatNumber(snapshot.demandScore),
        formatNumber(snapshot.competitionScore),
        snapshot.resultsCount ?? '',
        formatNumber(snapshot.adRatio),
        formatNumber(snapshot.dominanceIndex),
        formatNumber(snapshot.priceMedian),
        formatNumber(snapshot.priceIqrOverMedian),
        formatNumber(snapshot.favoritesAvg),
        formatNumber(snapshot.reviewVelocity),
        formatNumber(snapshot.trendsAvg),
        escapeCsv(explanation)
      ];
      rows.push(row.join(','));
    });

    writeFileSync(outputPath, `${rows.join('\n')}\n`, 'utf-8');
    this.deps.logger.info('Exported opportunity snapshot CSV', {
      outputPath,
      rows: top.length
    });

    return outputPath;
  }
}
