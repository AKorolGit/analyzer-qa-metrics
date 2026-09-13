export type Pattern = 'H' | 'L' | '*';
export type Severity = 'critical' | 'high' | 'medium' | 'info';

export interface RuleRow {
  readonly pattern: readonly Pattern[];
  readonly diagnosis: string;
  readonly firstAction: string;
  readonly severity: Severity;
}

export interface CombinationRule {
  readonly id: string;
  readonly title: string;
  readonly indicators: readonly string[];
  readonly source: string;
  readonly rows: readonly RuleRow[];
}

/**
 * Combination tables from the manual. Each row is a hypothesis with a first
 * action, never a verdict. A finding becomes a diagnosis for management only
 * when at least two independent lenses agree.
 */
export const combinationRules: readonly CombinationRule[] = [
  {
    id: 'C-Q1',
    title: 'Data trust x defect volume',
    indicators: ['Q1', 'FD'],
    source: 'Base Q1',
    rows: [
      { pattern: ['L', 'H'], diagnosis: 'Load is growing and reporting discipline is simplifying - data loss risk. Numbers describe the reporting, not the quality.', firstAction: 'Close the mandatory-field gap before acting on any other metric.', severity: 'critical' },
      { pattern: ['L', '*'], diagnosis: 'Field-dependent metrics are computed with a caveat or not at all.', firstAction: 'Make the missing attributes mandatory at creation; re-baseline in one month.', severity: 'high' },
      { pattern: ['H', 'L'], diagnosis: 'Data is fit for use.', firstAction: 'Hold; quarterly audit.', severity: 'info' },
    ],
  },
  {
    id: 'C-Q2',
    title: 'Rejected share x requirements-phase insertion',
    indicators: ['REJECTED', 'REQ_INSERTION'],
    source: 'Base Q2 / Q15',
    rows: [
      { pattern: ['H', 'H'], diagnosis: 'Requirements are ambiguous: QA and dev argue, and so do customer and product.', firstAction: 'Shift-left: acceptance criteria review with a definition-of-ready gate. Expanding the regression suite will not help.', severity: 'high' },
      { pattern: ['H', 'L'], diagnosis: 'Report quality or product knowledge in the QA team, not the requirements.', firstAction: 'Defect-report template with mandatory repro steps; pair triage for a sprint.', severity: 'medium' },
      { pattern: ['L', 'H'], diagnosis: 'Reports are good but requirements are weak.', firstAction: 'Shift-left on requirements; measure again next quarter.', severity: 'medium' },
    ],
  },
  {
    id: 'C-DDP-FD',
    title: 'DDP x field defects',
    indicators: ['DDP', 'FD'],
    source: 'Base Q9 / Q10',
    rows: [
      { pattern: ['L', 'H'], diagnosis: 'Testing is not catching what customers hit. Honest bad picture.', firstAction: 'Risk-based reinforcement of the main-journey regression (A10 hotspots first).', severity: 'critical' },
      { pattern: ['H', 'H'], diagnosis: 'A lot is caught pre-release and a lot still escapes - the release contains more defects than the process can filter.', firstAction: 'Check cohort sizes and release scope; consider smaller releases.', severity: 'high' },
      { pattern: ['L', 'L'], diagnosis: 'DDP looks bad but nothing reaches customers - suspect the tracker does not see production.', firstAction: 'Validate Env classification (M3 double sampling) before believing either number.', severity: 'high' },
      { pattern: ['H', 'L'], diagnosis: 'Detection is effective.', firstAction: 'Hold; watch the process behaviour chart.', severity: 'info' },
    ],
  },
  {
    id: 'C-FLAKY-DDP',
    title: 'Flaky rate x DDP',
    indicators: ['FLAKY', 'DDP'],
    source: 'R3 pair table',
    rows: [
      { pattern: ['H', 'L'], diagnosis: 'Worst combination: real failures drown in noise. No other CI signal can be trusted while this holds.', firstAction: 'Stabilise or quarantine flaky tests first - before any coverage work. Track skip count so stability is not "improved" by switching tests off.', severity: 'critical' },
      { pattern: ['H', 'H'], diagnosis: 'Detection works despite the noise, but the suite is burning trust and rerun time.', firstAction: 'Flaky-test budget: quarantine + owner per test.', severity: 'high' },
    ],
  },
  {
    id: 'C-REOPEN-FIX',
    title: 'Reopen rate x fix response time',
    indicators: ['REOPEN', 'FIX_LATE'],
    source: 'Base Q13 / M4.4',
    rows: [
      { pattern: ['H', 'L'], diagnosis: 'Fixes are rushed: fast turnaround, poor quality.', firstAction: 'Definition of done for a fix: reproduction test before closing.', severity: 'high' },
      { pattern: ['H', 'H'], diagnosis: 'A hard area or unclear requirements - fixes are both slow and wrong.', firstAction: 'Locate it: reopen rate by module (Q14) and requirements share (Q15).', severity: 'high' },
      { pattern: ['L', 'H'], diagnosis: 'Backlog is slow but fixes hold.', firstAction: 'Capacity or prioritisation decision, not a quality one.', severity: 'medium' },
    ],
  },
  {
    id: 'C-BMI-PLAN',
    title: 'Backlog index x planning lag',
    indicators: ['BMI', 'PLAN_LAG'],
    source: 'R3 pair table / M4.9',
    rows: [
      { pattern: ['L', 'H'], diagnosis: 'Backlog grows and defects wait sprints for a decision - accumulating technical debt with no triage cadence.', firstAction: 'Fixed defect triage slot per sprint with a WIP cap on the open backlog.', severity: 'high' },
      { pattern: ['L', '*'], diagnosis: 'Closing rate is below arrival rate.', firstAction: 'Watch p90 age of the open backlog for three periods before acting.', severity: 'medium' },
    ],
  },
  {
    id: 'C-CLUSTER',
    title: 'Defect concentration x change failure rate',
    indicators: ['PARETO', 'CFR'],
    source: 'Base Q14 / M4.3',
    rows: [
      { pattern: ['L', 'H'], diagnosis: 'Few components produce most defects and deployments fail often - a concentrated, addressable problem.', firstAction: 'Assign an owner per top-3 cluster and put them in the risk register for next quarter.', severity: 'high' },
      { pattern: ['H', 'H'], diagnosis: 'Defects are spread across many components and deployments fail - systemic, not local.', firstAction: 'Do not chase modules. Look at the change process: review depth, PR size, environment parity.', severity: 'high' },
    ],
  },
  {
    id: 'C-Q4',
    title: 'Untested high-level risks x field defects',
    indicators: ['RISK_UNTESTED', 'FD'],
    source: 'Base Q4',
    rows: [
      { pattern: ['H', 'H'], diagnosis: 'The gate was breached and the consequence is confirmed: risks went untested and customers found defects.', firstAction: 'Stop shipping with untested high risks. Every one needs a test or a signed acceptance before the gate.', severity: 'critical' },
      { pattern: ['L', 'H'], diagnosis: 'Risks are covered yet defects still escape - the risks are mis-assessed or the key ones were never identified (TM 1.3.6 "key risks missed").', firstAction: 'Re-run the risk workshop against the last quarter of field defects: which of them maps to no risk in the register?', severity: 'high' },
      { pattern: ['H', 'L'], diagnosis: 'Untested high risks have not bitten yet - luck, or the cohorts have not matured.', firstAction: 'Check cohort maturity before calling this safe.', severity: 'medium' },
    ],
  },
  {
    id: 'C-Q8',
    title: 'Accepted risk x delinquent fixes',
    indicators: ['RESIDUAL_UNSIGNED', 'FIX_LATE'],
    source: 'Base Q8 / M4.4',
    rows: [
      { pattern: ['H', '*'], diagnosis: 'High-level residual risk shipped without a named owner. Releasing with an accepted risk is legitimate; releasing with an unnamed one is not.', firstAction: 'No release proceeds until every high residual item has a signature and a workaround.', severity: 'critical' },
      { pattern: ['L', 'H'], diagnosis: 'Risk is named properly, but fixes overrun their targets - acceptance is becoming the default rather than the exception.', firstAction: 'Track accepted-risk items to closure with a deadline, not just to acceptance.', severity: 'medium' },
    ],
  },
  {
    id: 'C-TRACE',
    title: 'Traceability x code-archaeology admissibility',
    indicators: ['TRACE_BACK', 'PARETO'],
    source: 'R3 precondition',
    rows: [
      { pattern: ['L', '*'], diagnosis: 'Linkage is below the 25% precondition: hotspot and density conclusions would describe the teams that link carefully, not the risky code.', firstAction: 'Make the defect<->PR link mandatory in the pipeline; recompute in one month.', severity: 'high' },
    ],
  },
];

/** R3 §3: what to fix first, regardless of how loud the other signals are. */
export interface PriorityRule {
  readonly indicator: string;
  readonly condition: 'H' | 'L';
  readonly rank: number;
  readonly action: string;
  readonly rationale: string;
}

export const priorityOrder: readonly PriorityRule[] = [
  { indicator: 'FLAKY', condition: 'H', rank: 1, action: 'Stabilise the automated suite', rationale: 'While red is not read, no other CI signal works.' },
  { indicator: 'Q1', condition: 'L', rank: 2, action: 'Close the mandatory-attribute gap', rationale: 'Every other number is computed on this data.' },
  { indicator: 'OPEN_CRIT', condition: 'H', rank: 3, action: 'Clear or formally accept open critical defects', rationale: 'A release with an accepted risk is allowed; with an unnamed one it is not.' },
  { indicator: 'DDP', condition: 'L', rank: 4, action: 'Strengthen main-journey regression by risk', rationale: 'Escapes are reaching customers.' },
  { indicator: 'REQ_INSERTION', condition: 'H', rank: 5, action: 'Shift-left on requirements', rationale: 'Requirement defects have no guilty commit - more regression cannot catch them.' },
  { indicator: 'BMI', condition: 'L', rank: 6, action: 'Introduce a triage cadence and a backlog WIP cap', rationale: 'Growing backlog turns into unmanaged risk.' },
];
