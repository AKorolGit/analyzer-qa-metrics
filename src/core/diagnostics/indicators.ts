import type { MetricResult } from '../metrics/contract.js';
import type { ProjectProfile } from '../../domain/profile.js';

export type Level = 'H' | 'L' | 'M' | '?';

export interface Indicator {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  /** Three-state reading: H, L, M (mid-range) or ? (not computable). */
  readonly level: Level;
  /**
   * The manual's tables are binary. A mid-range value is coerced to the nearer
   * side so the table can be read at all - but any finding that used a coerced
   * value is downgraded to a hypothesis, never a diagnosis.
   */
  readonly binary: 'H' | 'L' | null;
  readonly coerced: boolean;
  readonly from: string;
  /** True when the underlying metric was degraded or unknown. */
  readonly weak: boolean;
  readonly note: string;
}

interface IndicatorSpec {
  readonly id: string;
  readonly label: string;
  readonly metricId: string;
  /** Value >= hi is High, value <= lo is Low, in between is ambiguous. */
  readonly hi: (p: ProjectProfile) => number;
  readonly lo: (p: ProjectProfile) => number;
  readonly extract?: (m: MetricResult) => number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const SPECS: readonly IndicatorSpec[] = [
  { id: 'Q1', label: 'Mandatory attribute completeness', metricId: 'Q1', hi: (p) => p.thresholds.completenessMin, lo: () => 0.7 },
  { id: 'REJECTED', label: 'Rejected / duplicate / no-repro share', metricId: 'Q2', hi: (p) => p.thresholds.badReportShareMax, lo: () => 0.08 },
  { id: 'TRACE_BACK', label: 'Backward traceability (defect -> requirement)', metricId: 'Q3', hi: () => 0.6, lo: () => 0.25 },
  { id: 'OPEN_CRIT', label: 'Open high-importance defects', metricId: 'Q7', hi: () => 1, lo: () => 0, extract: (m) => num(m.breakdown.find((r) => r['importance'] === 'critical')?.['open']) },
  { id: 'RISK_UNTESTED', label: 'High-level risks shipped unaccounted for', metricId: 'Q4', hi: () => 0.15, lo: () => 0.01 },
  { id: 'RESIDUAL_UNSIGNED', label: 'Unsigned high residual risks', metricId: 'Q8', hi: () => 1, lo: () => 0 },
  { id: 'GATE_FAILS', label: 'Failed release-gate criteria', metricId: 'GATE', hi: () => 2, lo: () => 0 },
  { id: 'DDP', label: 'DDP on important defects', metricId: 'Q9', hi: () => 0.9, lo: () => 0.75 },
  { id: 'FD', label: 'Field defects per mature cohort', metricId: 'Q10', hi: () => 6, lo: () => 2 },
  { id: 'REOPEN', label: 'Reopen rate', metricId: 'Q13', hi: (p) => p.thresholds.reopenRateMax, lo: () => 0.05 },
  { id: 'PARETO', label: 'Components producing 80% of defects', metricId: 'Q14', hi: () => 6, lo: () => 3 },
  { id: 'REQ_INSERTION', label: 'Share of defects inserted at requirements', metricId: 'Q15', hi: () => 0.25, lo: () => 0.1 },
  { id: 'FLAKY', label: 'Flaky pipeline rate', metricId: 'Q16', hi: (p) => p.thresholds.flakyRateMax, lo: () => 0.02 },
  { id: 'CFR', label: 'Change failure rate', metricId: 'M4.3', hi: () => 0.15, lo: () => 0.05 },
  { id: 'FIX_LATE', label: 'Delinquent fixes share', metricId: 'M4.4', hi: () => 0.2, lo: () => 0.1 },
  { id: 'BMI', label: 'Backlog Management Index', metricId: 'M4.6', hi: () => 100, lo: () => 90 },
  { id: 'PLAN_LAG', label: 'Sprints from detection to planned fix', metricId: 'M4.9', hi: () => 2, lo: () => 1 },
];

export function buildIndicators(
  results: readonly MetricResult[],
  profile: ProjectProfile,
): readonly Indicator[] {
  return SPECS.map((spec) => {
    const metric = results.find((r) => r.id === spec.metricId);
    const computed = metric !== undefined && (metric.status === 'computed' || metric.status === 'degraded');
    const value = !computed || metric === undefined ? null : (spec.extract?.(metric) ?? metric.value);
    let level: Level = '?';
    let binary: 'H' | 'L' | null = null;
    if (value !== null) {
      const hi = spec.hi(profile);
      const lo = spec.lo(profile);
      level = value >= hi ? 'H' : value <= lo ? 'L' : 'M';
      binary = level === 'M' ? (value >= (hi + lo) / 2 ? 'H' : 'L') : level;
    }
    return {
      id: spec.id,
      label: spec.label,
      value,
      level,
      binary,
      coerced: level === 'M',
      from: spec.metricId,
      weak: metric === undefined || metric.status !== 'computed',
      note: metric === undefined ? 'metric not in registry' : metric.status,
    };
  });
}
