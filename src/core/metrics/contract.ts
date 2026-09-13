import type { ProjectProfile } from '../../domain/profile.js';
import type { Snapshot } from '../../domain/types.js';
import type { NormalizedDefect } from '../normalize/index.js';
import type { FitnessReport } from '../fitness/index.js';
import type { ManualInputs } from '../../domain/manual-inputs.js';

export type MetricBlock =
  | 'A. Data trust'
  | 'B. Release gate'
  | 'C. Field outcome'
  | 'D. Process health'
  | 'E. Cost'
  | 'K. Contextual';

export type MetricStatus =
  | 'computed'
  | 'degraded'
  | 'not-computable'
  | 'needs-manual-input'
  | 'planned';

export type RequirementOutcome = 'met' | 'violated' | 'unknown';

export interface SeriesPoint {
  readonly label: string;
  readonly value: number;
  /** Cohorts whose observation window W has not elapsed are not comparable. */
  readonly mature: boolean;
  readonly n: number;
}

export interface MetricResult {
  readonly id: string;
  readonly name: string;
  readonly block: MetricBlock;
  readonly status: MetricStatus;
  readonly formulaVersion: string;
  /** Headline number. null when status is not `computed` / `degraded`. */
  readonly value: number | null;
  readonly unit: 'share' | 'count' | 'days' | 'percent' | 'ratio' | 'none';
  readonly series: readonly SeriesPoint[];
  readonly breakdown: readonly Readonly<Record<string, string | number | null>>[];
  readonly requirement: {
    readonly text: string;
    readonly outcome: RequirementOutcome;
  };
  /** Every reason the number is less trustworthy than it looks. */
  readonly caveats: readonly string[];
  readonly dependsOnFields: readonly string[];
}

export interface MetricContext {
  readonly snapshot: Snapshot;
  readonly defects: readonly NormalizedDefect[];
  readonly profile: ProjectProfile;
  readonly fitness: FitnessReport;
  readonly manual: ManualInputs;
  readonly now: Date;
}

export interface MetricDefinition {
  readonly id: string;
  readonly name: string;
  readonly block: MetricBlock;
  /** RawDefect fields the metric reads. The gate blocks it if any is unusable. */
  readonly dependsOnFields: readonly string[];
  /** Snapshot collections the metric needs. */
  readonly dependsOnSources: readonly ('defects' | 'releases' | 'deployments' | 'commits' | 'testRuns' | 'sprints')[];
  compute(ctx: MetricContext): MetricResult;
}

export function skeleton(
  def: MetricDefinition,
  over: Partial<MetricResult>,
): MetricResult {
  return {
    id: def.id,
    name: def.name,
    block: def.block,
    status: 'computed',
    formulaVersion: 'v1',
    value: null,
    unit: 'none',
    series: [],
    breakdown: [],
    requirement: { text: '', outcome: 'unknown' },
    caveats: [],
    dependsOnFields: def.dependsOnFields,
    ...over,
  };
}

/**
 * The gate. A metric is only allowed to run when its inputs exist and are fit.
 * This is the difference between a dashboard and an honest report.
 */
export function gate(def: MetricDefinition, ctx: MetricContext): MetricResult | null {
  const missingSources = def.dependsOnSources.filter((s) => ctx.snapshot[s].length === 0);
  if (missingSources.length > 0) {
    return skeleton(def, {
      status: 'not-computable',
      caveats: [`No data collected for: ${missingSources.join(', ')}.`],
      requirement: { text: '', outcome: 'unknown' },
    });
  }
  const unusable = def.dependsOnFields.filter((f) => ctx.fitness.unusableFields.includes(f));
  if (unusable.length > 0) {
    return skeleton(def, {
      status: 'not-computable',
      caveats: [
        `Fields unfit for use: ${unusable.join(', ')}. Fix data collection before reading this metric.`,
      ],
    });
  }
  return null;
}

export function degradedBy(def: MetricDefinition, ctx: MetricContext): readonly string[] {
  return def.dependsOnFields
    .filter((f) => ctx.fitness.degradedFields.includes(f))
    .map((f) => {
      const ff = ctx.fitness.fields.find((x) => x.field === f);
      return `${f}: ${ff?.reasons.join('; ') ?? 'degraded'}`;
    });
}
