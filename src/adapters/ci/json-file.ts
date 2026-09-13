import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CiPort, CollectResult, Period } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { Deployment, TestRun } from '../../domain/types.js';

/**
 * Reads run summaries emitted by the Playwright / Cypress reporters in
 * `reporters/`. This is the only CI source that can distinguish SUT failures
 * from TAS failures and inconclusive results (TAE 6.1.1, 7.1.3) - CI APIs
 * report "failed" and nothing more, which is exactly the distinction that
 * matters for Q16.
 */
export interface RunSummaryFile {
  readonly runId: string;
  readonly pipeline: string;
  readonly commitSha: string | null;
  readonly startedAt: string;
  readonly durationSeconds: number;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly tasFailures: number;
  readonly inconclusive: number;
  readonly retriedToGreen: number;
  readonly isRerun?: boolean;
}

export class JsonFileCi implements CiPort {
  readonly kind = 'json-file';

  constructor(private readonly directory: string) {}

  async fetchTestRuns(_profile: ProjectProfile, period: Period): Promise<CollectResult<TestRun>> {
    const dir = resolve(this.directory);
    if (!existsSync(dir)) {
      return {
        items: [],
        notes: [`Run-summary directory ${dir} does not exist; Q16 will report as not computable.`],
        unavailableFields: [],
      };
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const items: TestRun[] = [];
    const notes: string[] = [];
    let skipped = 0;
    for (const f of files) {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), 'utf8')) as RunSummaryFile;
        const at = Date.parse(raw.startedAt);
        if (at < Date.parse(period.from) || at > Date.parse(period.to)) continue;
        items.push({
          id: raw.runId,
          pipeline: raw.pipeline,
          commitSha: raw.commitSha,
          startedAt: raw.startedAt,
          durationSeconds: raw.durationSeconds,
          total: raw.total,
          passed: raw.passed,
          failed: raw.failed,
          skipped: raw.skipped,
          tasFailures: raw.tasFailures,
          inconclusive: raw.inconclusive,
          retriedToGreen: raw.retriedToGreen,
          isRerun: raw.isRerun ?? false,
        });
      } catch {
        skipped += 1;
      }
    }
    notes.push(`Loaded ${items.length} run summaries from ${dir}${skipped > 0 ? ` (${skipped} unreadable)` : ''}.`);
    return { items, notes, unavailableFields: [] };
  }

  async fetchDeployments(): Promise<CollectResult<Deployment>> {
    return { items: [], notes: ['JsonFileCi supplies test runs only; configure Azure Pipelines for deployments.'], unavailableFields: [] };
  }
}
