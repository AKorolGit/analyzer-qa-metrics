import type { MetricResult } from '../metrics/contract.js';
import type { Diagnosis } from '../diagnostics/engine.js';
import { formatValue } from '../diagnostics/engine.js';
import type { FitnessReport } from '../fitness/index.js';
import type { EnvMarkerAgreement, ScopeResult } from '../normalize/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { Snapshot } from '../../domain/types.js';

export interface ReportInput {
  readonly snapshot: Snapshot;
  readonly profile: ProjectProfile;
  readonly fitness: FitnessReport;
  readonly metrics: readonly MetricResult[];
  readonly diagnosis: Diagnosis;
  readonly scope: ScopeResult;
  readonly envAgreement: EnvMarkerAgreement;
  readonly envSources: Readonly<Record<string, number>>;
  readonly impSources: Readonly<Record<string, number>>;
  readonly cohortSources: Readonly<Record<string, number>>;
  readonly generatedAt: Date;
}

function table(rows: readonly Readonly<Record<string, string | number | null>>[]): string {
  if (rows.length === 0) return '_no rows_\n';
  const first = rows[0] as Readonly<Record<string, string | number | null>>;
  const headers = Object.keys(first);
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((r) => `| ${headers.map((h) => (r[h] === null || r[h] === undefined ? '—' : String(r[h]))).join(' | ')} |`)
    .join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

const STATUS_MARK: Readonly<Record<string, string>> = {
  computed: 'computed',
  degraded: 'DEGRADED',
  'not-computable': 'NOT COMPUTABLE',
  'needs-manual-input': 'NEEDS INPUT',
  planned: 'planned',
};

const OUTCOME_MARK: Readonly<Record<string, string>> = {
  met: 'met',
  violated: 'VIOLATED',
  unknown: '—',
};

function sourceTable(
  label: string,
  sources: Readonly<Record<string, number>>,
  total: number,
): readonly Readonly<Record<string, string | number | null>>[] {
  return Object.entries(sources)
    .sort((a, b) => b[1] - a[1])
    .map(([source, n]) => ({
      [label]: source,
      defects: n,
      share: `${((n / Math.max(1, total)) * 100).toFixed(0)}%`,
    }));
}

export function renderMarkdown(input: ReportInput): string {
  const { snapshot, profile, fitness, metrics, diagnosis, scope, envAgreement, generatedAt } = input;
  const inScope = scope.included.length;
  const out: string[] = [];

  out.push(`# QA measurement report — ${profile.name}`);
  out.push('');
  out.push(
    table([
      { key: 'Run ID', value: snapshot.runId },
      { key: 'Generated at', value: generatedAt.toISOString() },
      { key: 'Data collected at', value: snapshot.collectedAt },
      { key: 'Period', value: `${snapshot.period.from} → ${snapshot.period.to}` },
      { key: 'Tracker', value: profile.tracker.kind },
      { key: 'VCS', value: profile.vcs.kind },
      { key: 'Observation window W', value: `${profile.windowDays} days` },
      { key: 'Defects collected', value: scope.totalBefore },
      { key: 'Defects in scope', value: inScope },
      { key: 'Releases', value: snapshot.releases.length },
      {
        key: 'Formula versions',
        value: `T_det ${profile.versions.tDet}, Env ${profile.versions.env}, Imp ${profile.versions.imp}, Module ${profile.versions.module}, Cohort ${profile.versions.cohort}, Completeness ${profile.versions.completeness}`,
      },
    ]),
  );

  out.push('## 0. Scope and derivation');
  out.push('');
  out.push(`Filter: \`${scope.description}\``);
  out.push('');
  const excluded = Object.entries(scope.excludedByRule);
  if (excluded.length > 0) {
    out.push(
      table(
        excluded.map(([rule, n]) => ({
          rule,
          excluded: n,
          share: `${((n / Math.max(1, scope.totalBefore)) * 100).toFixed(1)}%`,
        })),
      ),
    );
  }
  for (const w of scope.biasWarnings) out.push(`- **Selection bias.** ${w}`);
  if (scope.biasWarnings.length === 0 && excluded.length > 0) {
    out.push('- Excluded defects show no marked difference in priority, state or reporter against the ones kept.');
  }
  out.push('');

  out.push('### Production markers');
  out.push('');
  out.push(
    table([
      { marker: 'tag AND title prefix agree', defects: envAgreement.both },
      { marker: 'tag only', defects: envAgreement.tagOnly },
      { marker: 'title prefix only', defects: envAgreement.titleOnly },
      { marker: 'no marker', defects: envAgreement.neither },
      { marker: 'DISAGREEMENT RATE', defects: `${(envAgreement.disagreementRate * 100).toFixed(0)}%` },
    ]),
  );
  for (const w of envAgreement.warnings) out.push(`- **${w}**`);
  if (envAgreement.warnings.length === 0 && envAgreement.markedTotal > 0) {
    out.push(
      '- The two markers agree closely, which is the best available evidence that the production classification behind DDP is trustworthy.',
    );
  }
  out.push('');
  out.push(table(sourceTable('Env resolved from', input.envSources, inScope)));
  out.push(table(sourceTable('Imp resolved from', input.impSources, inScope)));
  out.push(table(sourceTable('Cohort resolved from', input.cohortSources, inScope)));

  out.push('## 1. Purpose');
  out.push('');
  out.push(
    'Establish whether this project meets the minimum quality requirements: trustworthy data, a release gate with exit criteria, a stable field outcome, a measurably healthy process, and a known cost of quality.',
  );
  out.push('');

  out.push('## 2. What the data supports');
  out.push('');
  out.push(
    table(
      diagnosis.indicators
        .filter((i) => i.level !== '?')
        .slice(0, 10)
        .map((i) => ({
          indicator: i.label,
          value: formatValue(i.value),
          level: i.level,
          precision: i.weak ? 'degraded input — treat as directional' : 'computed on fit data',
          from: i.from,
        })),
    ),
  );

  out.push('## 3. What cannot be said yet, and why');
  out.push('');
  out.push('These are explicit blind spots, not omissions. Each one is a risk accepted until the listed input exists.');
  out.push('');
  out.push(
    table(
      diagnosis.blindSpots.map((b) => {
        const idx = b.indexOf(' - ');
        return {
          metric: idx === -1 ? b : b.slice(0, idx),
          reason: idx === -1 ? '' : b.slice(idx + 3),
        };
      }),
    ),
  );

  out.push('## 4. Diagnosis');
  out.push('');
  if (diagnosis.findings.length === 0) {
    out.push('_No combination rule fired. Either the project is healthy on the measured axes, or too few indicators could be classified — check section 3._');
    out.push('');
  } else {
    for (const f of diagnosis.findings) {
      out.push(`### [${f.severity.toUpperCase()}] ${f.title} — ${f.confidence}`);
      out.push('');
      out.push(f.diagnosis);
      out.push('');
      out.push(`**First action.** ${f.firstAction}`);
      out.push('');
      out.push(`**Evidence.** ${f.evidence.join(' · ')}  \n**Source.** ${f.source} (rule ${f.ruleId})`);
      out.push('');
    }
  }

  const gate = metrics.find((m) => m.id === 'GATE');
  if (gate !== undefined && gate.breakdown.length > 0) {
    out.push('## 5. Release gate (G1–G10)');
    out.push('');
    out.push(table(gate.breakdown));
    for (const c of gate.caveats) out.push(`- ${c}`);
    out.push('');
  }

  out.push('## 6. Signals vs noise (XmR)');
  out.push('');
  if (diagnosis.signals.length === 0) {
    out.push('_No Wheeler signal detected. Variation on the measured series is routine — do not react to it._');
    out.push('');
  } else {
    out.push(
      table(
        diagnosis.signals.flatMap((s) =>
          s.chart.signals.map((sig) => ({
            metric: `${s.metricId} ${s.metricName}`,
            point: sig.label,
            rule: sig.rule,
            direction: sig.direction,
            centre: Number(s.chart.centre.toFixed(3)),
            limits: `${s.chart.lowerLimit.toFixed(3)} … ${s.chart.upperLimit.toFixed(3)}`,
            note: s.chart.provisional ? 'provisional limits (<6 points)' : '',
          })),
        ),
      ),
    );
  }

  out.push('## 7. Proposals');
  out.push('');
  const top = diagnosis.actions.slice(0, 3);
  if (top.length === 0) {
    out.push('_No priority rule triggered._');
    out.push('');
  } else {
    out.push(
      table(
        top.map((a) => ({
          '#': a.rank,
          action: a.action,
          why: a.rationale,
          triggered_by: a.trigger,
        })),
      ),
    );
    out.push(
      'Maximum three proposals by design. Each needs an owner and an expected effect recorded **before** the change, so the next slice is a hypothesis test and not a retrospective justification.',
    );
    out.push('');
  }

  out.push('## 8. Next slice');
  out.push('');
  const next = new Date(generatedAt.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  out.push(
    `Recommended next measurement: **${next}** (monthly cadence for Q9–Q11, Q13, Q16; quarterly for Q1–Q3, Q14, Q15, Q17).`,
  );
  out.push('');

  out.push('---');
  out.push('');
  out.push('## Appendix A. Metric register');
  out.push('');
  out.push(
    table(
      metrics.map((m) => ({
        id: m.id,
        metric: m.name,
        block: m.block,
        status: STATUS_MARK[m.status] ?? m.status,
        version: m.formulaVersion,
        value: formatValue(m.value),
        requirement: m.requirement.text || '—',
        outcome: OUTCOME_MARK[m.requirement.outcome] ?? '—',
      })),
    ),
  );

  out.push('## Appendix B. Data fitness (ISO/IEC 25012)');
  out.push('');
  out.push(`Q1 (minimum over mandatory fields) = **${(fitness.q1 * 100).toFixed(1)}%** on n=${fitness.sampleSize} in-scope defects.`);
  out.push('');
  out.push(
    table(
      fitness.fields.map((f) => ({
        field: f.field,
        mandatory: f.mandatory ? 'yes' : '',
        completeness: `${(f.completeness * 100).toFixed(0)}%`,
        dominant: f.dominantValue === null ? '—' : `${f.dominantValue} (${(f.dominantShare * 100).toFixed(0)}%)`,
        verdict: f.verdict,
        reasons: f.reasons.join('; ') || '—',
      })),
    ),
  );

  out.push('## Appendix C. Metric detail');
  out.push('');
  for (const m of metrics) {
    if (m.breakdown.length === 0 && m.caveats.length === 0) continue;
    out.push(`### ${m.id} — ${m.name}`);
    out.push('');
    out.push(`Status: **${STATUS_MARK[m.status] ?? m.status}** · version: ${m.formulaVersion} · value: ${formatValue(m.value)}`);
    out.push('');
    if (m.breakdown.length > 0) out.push(table(m.breakdown));
    if (m.caveats.length > 0) {
      out.push('**Caveats.**');
      out.push('');
      for (const c of m.caveats) out.push(`- ${c}`);
      out.push('');
    }
  }

  out.push('## Appendix D. Collection notes');
  out.push('');
  for (const n of snapshot.sourceNotes) out.push(`- ${n}`);
  out.push('');

  return out.join('\n');
}