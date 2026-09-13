import { type MetricBlock, type MetricDefinition, type MetricStatus, skeleton } from './contract.js';

/**
 * Metrics that exist in the base but are deliberately NOT collected by this tool.
 * They still appear in the report - as an explicit, signed-off blind spot rather
 * than an informal omission. Silence is the failure mode this guards against.
 */
interface DeclaredSpec {
  readonly id: string;
  readonly name: string;
  readonly block: MetricBlock;
  readonly status: Extract<MetricStatus, 'needs-manual-input' | 'planned'>;
  readonly requirement: string;
  readonly why: string;
}

const DECLARED: readonly DeclaredSpec[] = [
  {
    id: 'Q6',
    name: 'Test execution status',
    block: 'B. Release gate',
    status: 'planned',
    requirement: '0 failed and 0 blocked among high-risk tests at the gate',
    why: 'Needs per-test-case results tied to a release, not just pipeline aggregates. Phase 4.',
  },
  {
    id: 'Q11',
    name: 'Production reliability: availability, MTTR, MTBF',
    block: 'C. Field outcome',
    status: 'planned',
    requirement: 'Availability >= SLA; MTTR within target',
    why: 'Needs a monitoring or incident source. v3 (unplanned patches per release) is already approximated by M4.3.',
  },
  {
    id: 'Q12',
    name: 'Non-functional minimum: performance and security',
    block: 'C. Field outcome',
    status: 'planned',
    requirement: '100% of key transactions within SLA; 0 open critical/high security findings',
    why: 'Needs load-test results and SAST/DAST output. Cheap to add once those run in the pipeline - they emit machine-readable reports.',
  },
  {
    id: 'K1',
    name: 'Reconciliation discrepancy rate',
    block: 'K. Contextual',
    status: 'planned',
    requirement: '0 unexplained discrepancies outside tolerance in critical flows',
    why: 'Mandatory when the product moves money or financial data between systems. Needs reconciliation points, not defect data.',
  },
  {
    id: 'K6',
    name: 'Risk-based testing effectiveness',
    block: 'K. Contextual',
    status: 'planned',
    requirement: 'Affirmative answer to all six CTAL-TM 1.3.6 questions',
    why: 'Partly computable once Q4 exists: share of high-importance defects found early is already derivable from Q15 and Q9.',
  },
];

export const declaredMetrics: readonly MetricDefinition[] = DECLARED.map((spec) => {
  const def: MetricDefinition = {
    id: spec.id,
    name: spec.name,
    block: spec.block,
    dependsOnFields: [],
    dependsOnSources: [],
    compute() {
      return skeleton(def, {
        status: spec.status,
        requirement: { text: spec.requirement, outcome: 'unknown' },
        caveats: [spec.why],
      });
    },
  };
  return def;
});
