/**
 * Human-readable documentation for every metric, shown behind the "i" icon.
 *
 * Kept next to the UI rather than inside the metric definitions on purpose:
 * the metric code states what it computes, this states why anyone should care
 * and how to read the number. Different audiences, different wording.
 */

export interface MetricDoc {
  /** One sentence: what this measures. */
  readonly what: string;
  /** The formula or rule, in words. */
  readonly how: string;
  /** How to read it, and the trap to avoid. */
  readonly read: string;
  readonly source: string;
}

export const METRIC_DOCS: Readonly<Record<string, MetricDoc>> = {
  Q1: {
    what: 'Share of defects that carry every mandatory attribute.',
    how: 'Minimum completeness across the fields marked mandatory in the profile. A field left at the tracker default counts as empty (completeness v1).',
    read: 'This gates everything else. Below 95% the other numbers describe your reporting habits rather than product quality. A field filled 100% by a tracker default is not filled.',
    source: 'CTAL-TM 2.3.5',
  },
  Q2: {
    what: 'Share of closed defects that turned out to be rejected, duplicate or not reproducible.',
    how: '(rejected + duplicate + no-repro) / all closed defects, with a Wilson interval for the sample size.',
    read: 'Rising share means wasted triage. Read together with Q15: high rejection plus requirement-phase defects points at ambiguous requirements, not sloppy testers.',
    source: 'CTAL-TM 2.3.6',
  },
  Q3: {
    what: 'How well defects link back to requirements and forward to code.',
    how: 'Share of defects with a parent work item, and share with a linked commit or pull request.',
    read: 'Code linkage below 25% blocks every hotspot and density conclusion — those would describe the teams that link carefully, not the risky code.',
    source: 'CTAL-TM 1.6.5',
  },
  Q4: {
    what: 'Whether high-level product risks were actually tested.',
    how: 'Risks scored likelihood x impact; a risk is unaccounted when it is failed or untested AND carries no signed acceptance in Q8.',
    read: 'The headline counts unaccounted risks, not untested ones. Shipping with an accepted risk is a decision; shipping with an unnamed one is a gate breach.',
    source: 'CTAL-TM 2.1.3',
  },
  Q5: {
    what: 'Share of requirements tested and passed, critical ones separately.',
    how: 'From the requirement list in the risk register file.',
    read: 'Counts requirements, not behaviours. A compound requirement passes as one item while half its conditions go untested.',
    source: 'CTAL-TM 2.1.3, CTEL-ITP 4.4.6.2',
  },
  Q6: {
    what: 'Execution status of the tests that matter at the gate.',
    how: 'Per-test-case results tied to a release. Not yet collected.',
    read: 'Pipeline aggregates cannot answer this: they say how many tests ran, not whether the high-risk ones passed.',
    source: 'CTAL-TM 2.1.3',
  },
  Q7: {
    what: 'Open defects by importance, with backlog age.',
    how: 'Count of unresolved defects per importance level, plus median and p90 age in days.',
    read: 'Zero open critical defects is the gate rule. A rising p90 age with a stable count means the backlog is ageing, not growing — a different problem.',
    source: 'CTAL-TM 2.3.6',
  },
  Q8: {
    what: 'Residual risk accepted at the release decision.',
    how: 'From the gate decision file: high-level items, their workaround, and who signed.',
    read: 'This is a decision record, not a measurement. The only inadmissible state is a high-level risk shipped with no name against it.',
    source: 'CTAL-TM 1.1.3, 3.2.2',
  },
  Q9: {
    what: 'Defect Detection Percentage: share of defects found before release.',
    how: 'pre-release / (pre-release + field defects within W days of release), per release cohort. Headline is the figure for important defects only.',
    read: 'The single most misread metric here. It is only as good as the production classification behind it — check the marker agreement table first. DDP_all can look excellent on a mass of trivial pre-release finds.',
    source: 'CTEL-ITP 4.4.2.1',
  },
  Q10: {
    what: 'Defects customers hit after a release, within the observation window.',
    how: 'Count of production defects per cohort within W days, plus rate per KLOC changed where churn is known.',
    read: 'Immature cohorts are shown but excluded from trends — their window has not elapsed, so they always look better.',
    source: 'CTEL-ITP 4.4.2',
  },
  Q11: {
    what: 'Production reliability: availability, MTTR, MTBF.',
    how: 'Needs a monitoring or incident source. Not collected.',
    read: 'M4.3 approximates the worst part of this from unplanned patches and rollbacks.',
    source: 'CTEL-ITP 4.4.3',
  },
  Q12: {
    what: 'Non-functional minimum: performance and security.',
    how: 'Needs load-test results and SAST/DAST output. Not collected.',
    read: 'Cheap to add once those run in the pipeline — they already emit machine-readable reports.',
    source: 'CTAL-TM 2.1.3',
  },
  Q13: {
    what: 'How often a fix fails and the defect comes back.',
    how: 'Share of resolved defects that later returned to an active state, broken down by module.',
    read: 'Read with M4.4. Fast fixes plus high reopen rate means rushed work; slow fixes plus high reopen rate means a hard area or unclear requirements.',
    source: 'Kan, defective fix rate',
  },
  Q14: {
    what: 'Where defects concentrate.',
    how: 'Defects per module as share and, where commit churn is available, per KLOC changed. Reports how many modules make up 80% of defects.',
    read: 'Share alone misleads: a large module that changes constantly will always lead. Density is the honest cut. If modules come from area paths rather than components, a cluster names a team territory, not code.',
    source: 'CTAL-TM 2.3.6',
  },
  Q15: {
    what: 'At which activity defects were introduced, and how many escaped.',
    how: 'Root cause bucketed into requirements, design/coding, configuration, external, detection gap — crossed with whether the defect reached production.',
    read: 'A high requirements share means more regression testing will not help; that is a shift-left problem. Only valid if root cause is filled evenly — biased fill makes this describe high-priority defects only.',
    source: 'CTAL-TM 3.2, defect causal analysis',
  },
  Q16: {
    what: 'Whether the automated regression suite can be trusted.',
    how: 'Flaky pipeline rate (failed then green on retry), share of failures caused by the automation rather than the product, count of tests that passed without asserting anything, and wall-clock duration.',
    read: 'First thing to fix when it is red: while nobody reads the failures, no other CI signal works. Watch skipped tests alongside it — stability can be "improved" by switching tests off.',
    source: 'CTAL-TAE 6.1.1, 7.1.3',
  },
  Q17: {
    what: 'What quality costs, split prevention / appraisal / internal failure / external failure.',
    how: 'From the cost model file; derives the average saving per defect caught before release.',
    read: 'The one number to take to management. Coverage percentages do not move budgets; cost per escaped defect does. An estimate is fine as long as it is labelled one.',
    source: 'CTAL-TM 3.2.1-3.2.2',
  },
  GATE: {
    what: 'The minimum release gate checklist, G1 to G10.',
    how: 'Each criterion resolved from its metric; a row with no data cannot pass.',
    read: 'A gate with unevaluable rows is not a gate — each NO DATA row is a release decision being made on assumption.',
    source: 'Metric base, release gate',
  },
  'M4.3': {
    what: 'Change failure rate and regression cycles (DORA).',
    how: 'Share of production deployments that were rollbacks, hotfixes or failures. Regression cycles counts test-environment deployments per release.',
    read: 'Many cycles inside a code freeze means change control effectively does not exist — an organisational fix, not a QA one.',
    source: 'DORA',
  },
  'M4.4': {
    what: 'How long fixes take against their target, per importance.',
    how: 'Median and p90 days to resolve, plus open defects already past target.',
    read: 'Open defects are censored observations: the median over closed ones understates real time-to-fix, and the more overdue work there is, the more it flatters you.',
    source: 'Kan, fix response time',
  },
  'M4.6': {
    what: 'Backlog Management Index: are you closing faster than defects arrive?',
    how: 'Closed / opened per month, as a percentage.',
    read: 'Below 100% for several periods means an accumulating backlog. Read with the p90 age from Q7 — the two together separate volume from ageing.',
    source: 'Kan, BMI',
  },
  'M4.9': {
    what: 'How many sprints a defect waits before a fix is even planned.',
    how: 'Sprint index of the first planned iteration minus the sprint the defect was detected in.',
    read: 'Not the same as defect lifetime. This measures decision speed — how long a defect sits without anyone deciding anything.',
    source: 'Process metrics, fix planning lag',
  },
  K1: {
    what: 'Reconciliation discrepancies in critical data flows.',
    how: 'Needs reconciliation points, not defect data.',
    read: 'Mandatory when the product moves money or financial data between systems.',
    source: 'Contextual metrics',
  },
  K6: {
    what: 'Whether risk-based testing is actually working.',
    how: 'The six questions of CTAL-TM 1.3.6, partly derivable once Q4 exists.',
    read: 'The useful one: were the key risks identified at all, or only the ones someone already had tests for?',
    source: 'CTAL-TM 1.3.6',
  },
};

export const BLOCK_DOCS: Readonly<Record<string, string>> = {
  'A. Data trust':
    'Whether the data can support any conclusion at all. Runs first and gates everything else — a metric computed on unfit data is worse than no metric.',
  'B. Release gate':
    'The exit criteria for shipping. Mostly fed by files you maintain, because a risk register and a release decision are decisions, not measurements.',
  'C. Field outcome': 'What customers actually experienced after each release.',
  'D. Process health': 'Whether the way the team finds and fixes defects is working.',
  'E. Cost': 'What quality costs and what catching defects earlier is worth.',
  'K. Contextual': 'Domain-specific criteria that only apply to some products.',
};