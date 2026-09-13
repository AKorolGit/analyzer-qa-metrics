/**
 * Shared classification of a test outcome into the three states CTAL-TAE 6.1.1
 * requires an organisation to define explicitly:
 *
 *   SUT failure   - the product is wrong. Counts towards defect metrics.
 *   TAS failure   - the automation, environment or infrastructure is wrong.
 *                   Must NOT count towards defect metrics.
 *   inconclusive  - the test finished green without asserting anything
 *                   (TAE 7.1.3). The most dangerous state, because it looks fine.
 *
 * The patterns below are a starting point. Tune them on your own failures and
 * keep the list in version control - the syllabus point is that the definitions
 * are explicit and consistent, not that they are clever.
 */

export const TAS_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i,
  /browser (has been )?closed|target closed|page crashed|session not created/i,
  /net::ERR_/i,
  /webdriver|chromedriver|playwright install/i,
  /failed to (start|launch|connect to)/i,
  /docker|container|kubernetes|pod .* not ready/i,
  /502 Bad Gateway|503 Service Unavailable|504 Gateway/i,
  /out of memory|heap limit/i,
  /error in (before|after)(All|Each) hook/i,
  /fixture .* failed/i,
];

export type FailureClass = 'SUT' | 'TAS' | 'inconclusive';

export interface ClassifyInput {
  readonly status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  readonly errorText: string;
  readonly assertionCount: number;
  /** Explicit override from a test annotation or tag, e.g. @tas. */
  readonly declared?: FailureClass;
}

export function classify(input: ClassifyInput): FailureClass | null {
  if (input.declared !== undefined) return input.declared;
  if (input.status === 'passed') {
    return input.assertionCount === 0 ? 'inconclusive' : null;
  }
  if (input.status === 'skipped') return null;
  return TAS_PATTERNS.some((p) => p.test(input.errorText)) ? 'TAS' : 'SUT';
}
