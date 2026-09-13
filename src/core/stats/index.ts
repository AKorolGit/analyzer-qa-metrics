/** Statistics used by the manual: Wilson intervals (M3) and XmR charts (R3). */

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/** Wilson score interval - used wherever a share is reported on a small n. */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - spread) / denom), high: Math.min(1, (centre + spread) / denom) };
}

export type WheelerRule = 'point-outside-limits' | 'three-of-four-near-limit' | 'eight-on-one-side';

export interface XmrSignal {
  readonly index: number;
  readonly label: string;
  readonly rule: WheelerRule;
  readonly direction: 'up' | 'down';
}

export interface XmrChart {
  readonly labels: readonly string[];
  readonly values: readonly number[];
  readonly centre: number;
  readonly upperLimit: number;
  readonly lowerLimit: number;
  readonly movingRangeLimit: number;
  readonly signals: readonly XmrSignal[];
  /** Wheeler: limits from fewer than 6 points are provisional. */
  readonly provisional: boolean;
}

/**
 * XmR / process behaviour chart (Wheeler).
 * Limits = X̄ ± 2.66 × mR̄ ; mR upper limit = 3.27 × mR̄.
 */
export function xmr(labels: readonly string[], values: readonly number[]): XmrChart | null {
  if (values.length < 3) return null;
  const centre = mean(values) as number;
  const ranges: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    ranges.push(Math.abs((values[i] as number) - (values[i - 1] as number)));
  }
  const mrBar = mean(ranges) ?? 0;
  const upper = centre + 2.66 * mrBar;
  const lower = centre - 2.66 * mrBar;
  const signals: XmrSignal[] = [];

  values.forEach((v, i) => {
    if (v > upper) signals.push({ index: i, label: labels[i] ?? String(i), rule: 'point-outside-limits', direction: 'up' });
    else if (v < lower) signals.push({ index: i, label: labels[i] ?? String(i), rule: 'point-outside-limits', direction: 'down' });
  });

  const nearUpper = centre + (upper - centre) / 1.5;
  const nearLower = centre - (centre - lower) / 1.5;
  for (let i = 3; i < values.length; i += 1) {
    const window = values.slice(i - 3, i + 1);
    const up = window.filter((v) => v > nearUpper).length;
    const down = window.filter((v) => v < nearLower).length;
    if (up >= 3) signals.push({ index: i, label: labels[i] ?? String(i), rule: 'three-of-four-near-limit', direction: 'up' });
    if (down >= 3) signals.push({ index: i, label: labels[i] ?? String(i), rule: 'three-of-four-near-limit', direction: 'down' });
  }

  for (let i = 7; i < values.length; i += 1) {
    const window = values.slice(i - 7, i + 1);
    if (window.every((v) => v > centre)) signals.push({ index: i, label: labels[i] ?? String(i), rule: 'eight-on-one-side', direction: 'up' });
    if (window.every((v) => v < centre)) signals.push({ index: i, label: labels[i] ?? String(i), rule: 'eight-on-one-side', direction: 'down' });
  }

  return {
    labels,
    values,
    centre,
    upperLimit: upper,
    lowerLimit: lower,
    movingRangeLimit: 3.27 * mrBar,
    signals,
    provisional: values.length < 6,
  };
}
