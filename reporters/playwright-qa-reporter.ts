import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, type FailureClass } from './failure-class.js';

/**
 * Playwright reporter that emits one run summary per run, in the shape
 * JsonFileCi reads. Register it in playwright.config.ts:
 *
 *   reporters: [['./reporters/playwright-qa-reporter.ts', { outputDir: 'qa-runs' }]]
 *
 * Assertion counting uses Playwright's own `expect` step category, so a test
 * that navigates, waits and returns green without a single expect is recorded
 * as inconclusive rather than passed.
 */

interface Options {
  readonly outputDir?: string;
  readonly pipeline?: string;
}

interface PwStep {
  readonly category: string;
  readonly steps?: readonly PwStep[];
}
interface PwResult {
  readonly status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  readonly duration: number;
  readonly retry: number;
  readonly error?: { message?: string; stack?: string };
  readonly steps?: readonly PwStep[];
}
interface PwTestCase {
  readonly id: string;
  readonly title: string;
  outcome(): 'expected' | 'unexpected' | 'flaky' | 'skipped';
  readonly annotations?: readonly { type: string; description?: string }[];
}

function countExpects(steps: readonly PwStep[] | undefined): number {
  if (steps === undefined) return 0;
  return steps.reduce(
    (acc, s) => acc + (s.category === 'expect' ? 1 : 0) + countExpects(s.steps),
    0,
  );
}

export default class QaMetricsReporter {
  private readonly outputDir: string;
  private readonly pipeline: string;
  private startedAt = new Date();
  private total = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private tasFailures = 0;
  private inconclusive = 0;
  private retriedToGreen = 0;
  private readonly perTest: { title: string; failureClass: FailureClass | null; retries: number }[] = [];

  constructor(options: Options = {}) {
    this.outputDir = options.outputDir ?? 'qa-runs';
    this.pipeline = options.pipeline ?? process.env['QA_PIPELINE'] ?? 'regression';
  }

  onBegin(): void {
    this.startedAt = new Date();
  }

  onTestEnd(test: PwTestCase, result: PwResult): void {
    // Only the final attempt counts towards the totals; earlier attempts feed flakiness.
    const outcome = test.outcome();
    if (result.retry > 0 && outcome !== 'flaky') return;

    const declared = test.annotations?.find((a) => a.type === 'tas') !== undefined ? ('TAS' as FailureClass) : undefined;
    const errorText = `${result.error?.message ?? ''}\n${result.error?.stack ?? ''}`;
    const failureClass = classify({
      status: result.status,
      errorText,
      assertionCount: countExpects(result.steps),
      ...(declared === undefined ? {} : { declared }),
    });

    if (result.retry > 0 && outcome === 'flaky') {
      this.retriedToGreen += 1;
      return;
    }

    this.total += 1;
    if (result.status === 'skipped') {
      this.skipped += 1;
    } else if (result.status === 'passed') {
      this.passed += 1;
      if (failureClass === 'inconclusive') this.inconclusive += 1;
    } else {
      this.failed += 1;
      if (failureClass === 'TAS') this.tasFailures += 1;
    }
    this.perTest.push({ title: test.title, failureClass, retries: result.retry });
  }

  onEnd(): void {
    mkdirSync(this.outputDir, { recursive: true });
    const runId = `${this.startedAt.toISOString().replace(/[:.]/g, '-')}-${this.pipeline}`;
    const summary = {
      runId,
      pipeline: this.pipeline,
      commitSha: process.env['BUILD_SOURCEVERSION'] ?? process.env['GITHUB_SHA'] ?? null,
      startedAt: this.startedAt.toISOString(),
      durationSeconds: (Date.now() - this.startedAt.getTime()) / 1000,
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      tasFailures: this.tasFailures,
      inconclusive: this.inconclusive,
      retriedToGreen: this.retriedToGreen,
      isRerun: false,
    };
    writeFileSync(join(this.outputDir, `${runId}.json`), JSON.stringify(summary, null, 2), 'utf8');
    // A per-test detail file enables the test-suite archaeology of step P6 later.
    writeFileSync(join(this.outputDir, `${runId}.tests.json`), JSON.stringify(this.perTest, null, 2), 'utf8');
  }
}
