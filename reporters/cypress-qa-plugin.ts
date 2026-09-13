import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from './failure-class.js';

/**
 * Cypress equivalent of the Playwright reporter. Two pieces are needed because
 * Cypress splits browser and node contexts.
 *
 * 1) support/e2e.ts - count assertions per test in the browser:
 *
 *      let assertions = 0;
 *      beforeEach(() => { assertions = 0; });
 *      Cypress.on('command:end', (c) => { if (c.attributes.name === 'assert') assertions += 1; });
 *      afterEach(function () {
 *        cy.task('qaMetrics:test', {
 *          title: this.currentTest?.fullTitle(),
 *          state: this.currentTest?.state,
 *          error: this.currentTest?.err?.message ?? '',
 *          assertions,
 *          attempt: this.currentTest?.currentRetry?.() ?? 0,
 *        }, { log: false });
 *      });
 *
 * 2) cypress.config.ts - register this plugin in setupNodeEvents:
 *
 *      import { registerQaMetrics } from './reporters/cypress-qa-plugin';
 *      setupNodeEvents(on) { registerQaMetrics(on, { outputDir: 'qa-runs' }); }
 *
 * Cypress reports assertion counts only through the command log, so the
 * inconclusive check is weaker here than in Playwright. Treat the Cypress
 * inconclusive figure as a lower bound and say so in the report.
 */

export interface TestPayload {
  readonly title: string;
  readonly state: 'passed' | 'failed' | 'pending' | undefined;
  readonly error: string;
  readonly assertions: number;
  readonly attempt: number;
}

interface Options {
  readonly outputDir?: string;
  readonly pipeline?: string;
}

type EventRegistrar = (event: string, handler: (arg: unknown) => unknown) => void;

export function registerQaMetrics(on: EventRegistrar, options: Options = {}): void {
  const outputDir = options.outputDir ?? 'qa-runs';
  const pipeline = options.pipeline ?? process.env['QA_PIPELINE'] ?? 'regression';
  const startedAt = new Date();
  const seen = new Map<string, TestPayload>();
  const retried = new Set<string>();

  on('task', (arg: unknown) => {
    const payload = arg as TestPayload | undefined;
    if (payload?.title === undefined) return null;
    if (payload.attempt > 0) retried.add(payload.title);
    seen.set(payload.title, payload);
    return null;
  });

  on('after:run', () => {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let tasFailures = 0;
    let inconclusive = 0;
    for (const t of seen.values()) {
      const status = t.state === 'passed' ? 'passed' : t.state === 'pending' ? 'skipped' : 'failed';
      const cls = classify({ status, errorText: t.error, assertionCount: t.assertions });
      if (status === 'passed') {
        passed += 1;
        if (cls === 'inconclusive') inconclusive += 1;
      } else if (status === 'skipped') {
        skipped += 1;
      } else {
        failed += 1;
        if (cls === 'TAS') tasFailures += 1;
      }
    }
    const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${pipeline}`;
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, `${runId}.json`),
      JSON.stringify(
        {
          runId,
          pipeline,
          commitSha: process.env['BUILD_SOURCEVERSION'] ?? process.env['GITHUB_SHA'] ?? null,
          startedAt: startedAt.toISOString(),
          durationSeconds: (Date.now() - startedAt.getTime()) / 1000,
          total: seen.size,
          passed,
          failed,
          skipped,
          tasFailures,
          inconclusive,
          retriedToGreen: [...retried].filter((title) => seen.get(title)?.state === 'passed').length,
          isRerun: false,
        },
        null,
        2,
      ),
      'utf8',
    );
    return null;
  });
}
