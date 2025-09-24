export function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

export function iqr(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const q1 = percentile(values, 25);
  const q3 = percentile(values, 75);
  if (q1 === null || q3 === null) {
    return null;
  }
  return q3 - q1;
}

export function standardDeviation(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const avg = mean(values);
  if (avg === null) {
    return null;
  }
  const variance = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function medianAbsoluteDeviation(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const med = median(values);
  if (med === null) {
    return null;
  }
  const deviations = values.map((value) => Math.abs(value - med));
  return median(deviations);
}

export function robustNormalize(value: number, series: number[]): number {
  if (!Number.isFinite(value) || series.length === 0) {
    return 0;
  }
  const med = median(series);
  const spread = iqr(series) ?? medianAbsoluteDeviation(series) ?? 1;
  if (med === null || !Number.isFinite(spread) || spread === 0) {
    return value;
  }
  return (value - med) / spread;
}

export function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
