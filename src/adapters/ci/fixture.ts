import type { CiPort, CollectResult, Period } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { Deployment, TestRun } from '../../domain/types.js';

const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

/** Synthetic CI with planted flakiness and an excessive number of freeze-window cycles. */
export class FixtureCi implements CiPort {
  readonly kind = 'fixture';

  async fetchDeployments(_profile: ProjectProfile, period: Period): Promise<CollectResult<Deployment>> {
    const from = new Date(period.from);
    const span = (new Date(period.to).getTime() - from.getTime()) / 86_400_000;
    const step = span / 9;
    const items: Deployment[] = [];
    for (let rel = 0; rel < 8; rel += 1) {
      const cycles = 6; // planted: code freeze effectively does not exist
      for (let c = 0; c < cycles; c += 1) {
        items.push({
          id: `test-${rel}-${c}`,
          environment: 'test',
          deployedAt: addDays(from, step * (rel + 1) - 7 + c).toISOString(),
          succeeded: true,
          isRollback: false,
          isHotfix: false,
          releaseId: `rel-${rel}`,
        });
      }
      items.push({
        id: `prod-${rel}`,
        environment: 'production',
        deployedAt: addDays(from, step * (rel + 1)).toISOString(),
        succeeded: true,
        isRollback: false,
        isHotfix: false,
        releaseId: `rel-${rel}`,
      });
      if (rel % 3 === 0) {
        items.push({
          id: `hotfix-${rel}`,
          environment: 'production',
          deployedAt: addDays(from, step * (rel + 1) + 2).toISOString(),
          succeeded: true,
          isRollback: false,
          isHotfix: true,
          releaseId: `rel-${rel}`,
        });
      }
    }
    return { items, notes: ['Fixture deployments.'], unavailableFields: [] };
  }

  async fetchTestRuns(_profile: ProjectProfile, period: Period): Promise<CollectResult<TestRun>> {
    const from = new Date(period.from);
    const items: TestRun[] = [];
    for (let i = 0; i < 60; i += 1) {
      const total = 480;
      const failed = 4 + (i % 7);
      const tas = Math.round(failed * 0.6); // planted: most red is the automation, not the SUT
      items.push({
        id: `run-${i}`,
        pipeline: 'regression',
        commitSha: null,
        startedAt: addDays(from, i * 3).toISOString(),
        durationSeconds: 3600 + (i % 5) * 600,
        total,
        passed: total - failed,
        failed,
        skipped: 12,
        tasFailures: tas,
        inconclusive: i % 10 === 0 ? 3 : 0,
        retriedToGreen: i % 7 === 0 ? 2 : i % 11 === 0 ? 1 : 0, // planted: flaky pipeline rate ~14%
        isRerun: false,
      });
    }
    return { items, notes: ['Fixture CI runs.'], unavailableFields: [] };
  }
}

/** Used when no CI source is configured: metrics depending on it become not-computable. */
export class NullCi implements CiPort {
  readonly kind = 'none';
  async fetchDeployments(): Promise<CollectResult<Deployment>> {
    return { items: [], notes: ['No CI source configured; DORA and regression metrics are not computable.'], unavailableFields: [] };
  }
  async fetchTestRuns(): Promise<CollectResult<TestRun>> {
    return { items: [], notes: [], unavailableFields: [] };
  }
}
