import type { MetricResult } from '../metrics/contract.js';
import type { ProjectProfile } from '../../domain/profile.js';
import { type Indicator, buildIndicators } from './indicators.js';
import { type Severity, combinationRules, priorityOrder } from './rules.js';
import { xmr, type XmrChart } from '../stats/index.js';

export type Confidence = 'confirmed' | 'hypothesis' | 'weak';

export interface Finding {
  readonly ruleId: string;
  readonly title: string;
  readonly diagnosis: string;
  readonly firstAction: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly evidence: readonly string[];
  readonly source: string;
}

export interface SignalFinding {
  readonly metricId: string;
  readonly metricName: string;
  readonly chart: XmrChart;
}

export interface ActionItem {
  readonly rank: number;
  readonly action: string;
  readonly rationale: string;
  readonly trigger: string;
}

export interface Diagnosis {
  readonly indicators: readonly Indicator[];
  readonly findings: readonly Finding[];
  readonly signals: readonly SignalFinding[];
  readonly actions: readonly ActionItem[];
  readonly blindSpots: readonly string[];
}

function matches(indicator: Indicator, pattern: string): boolean {
  if (indicator.binary === null) return false;
  if (pattern === '*') return true;
  return indicator.binary === pattern;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
};

export function diagnose(
  results: readonly MetricResult[],
  profile: ProjectProfile,
): Diagnosis {
  const indicators = buildIndicators(results, profile);
  const byId = new Map(indicators.map((i) => [i.id, i]));
  const findings: Finding[] = [];

  for (const rule of combinationRules) {
    const used = rule.indicators.map((id) => byId.get(id));
    if (used.some((i) => i === undefined || i.binary === null)) continue;
    const present = used as Indicator[];
    for (const row of rule.rows) {
      const hit = row.pattern.every((p, idx) => matches(present[idx] as Indicator, p));
      if (!hit) continue;
      const anyWeak = present.some((i) => i.weak);
      const anyCoerced = present.some((i) => i.coerced);
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        diagnosis: row.diagnosis,
        firstAction: row.firstAction,
        severity: row.severity,
        confidence: anyWeak && anyCoerced ? 'weak' : anyWeak || anyCoerced ? 'hypothesis' : 'confirmed',
        source: rule.source,
        evidence: present.map(
          (i) =>
            `${i.label} = ${i.value === null ? 'n/a' : formatValue(i.value)} (${i.level}${i.coerced ? ` → read as ${i.binary}` : ''}${i.weak ? ', degraded input' : ''})`,
        ),
      });
      break; // first matching row wins; the table is ordered by specificity
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const signals: SignalFinding[] = [];
  for (const r of results) {
    if (r.series.length < 3) continue;
    const chart = xmr(r.series.map((p) => p.label), r.series.map((p) => p.value));
    if (chart !== null && chart.signals.length > 0) {
      signals.push({ metricId: r.id, metricName: r.name, chart });
    }
  }

  const actions: ActionItem[] = priorityOrder
    .filter((p) => byId.get(p.indicator)?.binary === p.condition)
    .sort((a, b) => a.rank - b.rank)
    .map((p, idx) => ({
      rank: idx + 1,
      action: p.action,
      rationale: p.rationale,
      trigger: `${byId.get(p.indicator)?.label ?? p.indicator} = ${formatValue(byId.get(p.indicator)?.value ?? null)}`,
    }));

  const blindSpots = results
    .filter((r) => r.status === 'not-computable' || r.status === 'needs-manual-input' || r.status === 'planned')
    .map((r) => `${r.id} ${r.name} - ${r.caveats[0] ?? r.status}`);

  return { indicators, findings, signals, actions, blindSpots };
}

export function formatValue(v: number | null): string {
  if (v === null) return 'n/a';
  if (Math.abs(v) < 1 && v !== 0) return `${(v * 100).toFixed(1)}%`;
  return v.toFixed(2).replace(/\.00$/, '');
}
