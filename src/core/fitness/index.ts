import type { ProjectProfile, CompletenessVersion } from '../../domain/profile.js';
import type { RawDefect } from '../../domain/types.js';

/**
 * D4. Data fitness per ISO/IEC 25012. Decides which metrics may be computed
 * at all. This runs BEFORE any metric, and its verdicts are binding.
 */

export type FitnessVerdict = 'usable' | 'degraded' | 'unusable';

export interface FieldFitness {
  readonly field: string;
  readonly mandatory: boolean;
  /** D4.1 completeness, per selected version. */
  readonly completeness: number;
  readonly completenessVersion: CompletenessVersion;
  /** Dominant value and its share - a 100% filled field with one value is not data. */
  readonly dominantValue: string | null;
  readonly dominantShare: number;
  /** MAR/MNAR check: is fill rate uneven across a grouping key? */
  readonly missingnessBiasedBy: readonly string[];
  readonly verdict: FitnessVerdict;
  readonly reasons: readonly string[];
}

export interface FitnessReport {
  readonly sampleSize: number;
  readonly fields: readonly FieldFitness[];
  /** Q1 = min over mandatory fields. */
  readonly q1: number;
  readonly unusableFields: readonly string[];
  readonly degradedFields: readonly string[];
}

function valueOf(d: RawDefect, field: string): string | null {
  const record = d as unknown as Record<string, unknown>;
  const v = record[field];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length === 0 ? null : v.join(',');
  const s = String(v);
  return s.trim() === '' ? null : s;
}

function changedFromDefault(d: RawDefect, field: string): boolean {
  return d.history.some((h) => h.field === field);
}

export function completeness(
  defects: readonly RawDefect[],
  field: string,
  defaultValue: string | null,
  version: CompletenessVersion,
): number {
  if (defects.length === 0) return 0;
  let filled = 0;
  for (const d of defects) {
    const v = valueOf(d, field);
    if (version === 'v1') {
      if (changedFromDefault(d, field) || (v !== null && v !== defaultValue)) filled += 1;
    } else if (version === 'v2') {
      if (v !== null && v !== defaultValue) filled += 1;
    } else if (v !== null) filled += 1;
  }
  return filled / defects.length;
}

function dominant(defects: readonly RawDefect[], field: string): { value: string | null; share: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const d of defects) {
    const v = valueOf(d, field);
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return { value: null, share: 0 };
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return { value: best, share: bestCount / total };
}

/**
 * Rubin (1976): if fill rate depends on another attribute, the filled part is a
 * biased sample and any conclusion drawn on it is biased too.
 */
function missingnessBias(
  defects: readonly RawDefect[],
  field: string,
  groupBy: readonly string[],
): readonly string[] {
  const biased: string[] = [];
  for (const key of groupBy) {
    const groups = new Map<string, { filled: number; total: number }>();
    for (const d of defects) {
      const g = valueOf(d, key) ?? '(none)';
      const cur = groups.get(g) ?? { filled: 0, total: 0 };
      cur.total += 1;
      if (valueOf(d, field) !== null) cur.filled += 1;
      groups.set(g, cur);
    }
    const rates = [...groups.values()].filter((g) => g.total >= 10).map((g) => g.filled / g.total);
    if (rates.length >= 2) {
      const spread = Math.max(...rates) - Math.min(...rates);
      if (spread > 0.3) biased.push(key);
    }
  }
  return biased;
}

export function assessFitness(
  defects: readonly RawDefect[],
  profile: ProjectProfile,
): FitnessReport {
  const version = profile.versions.completeness;
  const groupKeys = ['priority', 'component', 'createdBy'];
  const fields: FieldFitness[] = profile.fields.map((policy) => {
    const c = completeness(defects, policy.field, policy.defaultValue, version);
    const dom = dominant(defects, policy.field);
    const bias = missingnessBias(defects, policy.field, groupKeys);
    const reasons: string[] = [];
    let verdict: FitnessVerdict = 'usable';

    if (c < 0.5) {
      verdict = 'unusable';
      reasons.push(`completeness ${(c * 100).toFixed(0)}% < 50%`);
    } else if (c < profile.thresholds.completenessMin) {
      verdict = 'degraded';
      reasons.push(
        `completeness ${(c * 100).toFixed(0)}% below target ${(profile.thresholds.completenessMin * 100).toFixed(0)}%`,
      );
    }
    if (dom.share > profile.thresholds.dominanceMax && policy.field !== 'stateCategory') {
      if (verdict === 'usable') verdict = 'degraded';
      reasons.push(
        `dominant value "${dom.value}" at ${(dom.share * 100).toFixed(0)}% - field does not discriminate`,
      );
    }
    if (bias.length > 0) {
      if (verdict === 'usable') verdict = 'degraded';
      reasons.push(`fill rate depends on ${bias.join(', ')} (MAR/MNAR): filled subset is biased`);
    }
    return {
      field: policy.field,
      mandatory: policy.mandatory,
      completeness: c,
      completenessVersion: version,
      dominantValue: dom.value,
      dominantShare: dom.share,
      missingnessBiasedBy: bias,
      verdict,
      reasons,
    };
  });

  const mandatory = fields.filter((f) => f.mandatory);
  const q1 = mandatory.length === 0 ? 0 : Math.min(...mandatory.map((f) => f.completeness));

  return {
    sampleSize: defects.length,
    fields,
    q1,
    unusableFields: fields.filter((f) => f.verdict === 'unusable').map((f) => f.field),
    degradedFields: fields.filter((f) => f.verdict === 'degraded').map((f) => f.field),
  };
}
