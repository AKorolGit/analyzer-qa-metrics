import type { CiPort, CollectResult, Period } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { Deployment, TestRun } from '../../domain/types.js';
import { projectUrl, releaseProjectUrl } from '../tracker/ado-url.js';

const API = '7.1';

interface DeploymentsResponse {
  value?: {
    id: number;
    deploymentStatus?: string;
    operationStatus?: string;
    startedOn?: string;
    completedOn?: string;
    reason?: string;
    release?: { id?: number; name?: string };
    releaseEnvironment?: { name?: string };
    attempt?: number;
  }[];
}

interface TestRunsResponse {
  value?: {
    id: number;
    name?: string;
    startedDate?: string;
    completedDate?: string;
    totalTests?: number;
    passedTests?: number;
    notApplicableTests?: number;
    incompleteTests?: number;
    unanalyzedTests?: number;
    buildConfiguration?: { sourceVersion?: string };
  }[];
}

/**
 * Azure Pipelines / Releases.
 *
 * Note on what this CANNOT give you: the ADO test API reports pass/fail and an
 * "unanalyzed" bucket, but has no concept of a TAS failure. Classifying red as
 * automation-vs-product needs the runner to say so - see reporters/ and
 * JsonFileCi. Use this adapter for deployments; combine with JsonFileCi for Q16.
 */
export class AzurePipelinesCi implements CiPort {
  readonly kind = 'azure-pipelines';

  constructor(
    private readonly pat: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`:${this.pat}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }

  private base(profile: ProjectProfile): string {
    return projectUrl(profile.tracker.baseUrl, profile.tracker.organization, profile.tracker.project);
  }

  /** Release Management is on vsrm.* in the cloud, same host on-prem. */
  private releaseBase(profile: ProjectProfile): string {
    return releaseProjectUrl(profile.tracker.baseUrl, profile.tracker.organization, profile.tracker.project);
  }

  async fetchDeployments(profile: ProjectProfile, period: Period): Promise<CollectResult<Deployment>> {
    const url = `${this.releaseBase(profile)}/_apis/release/deployments?minStartedTime=${period.from}&maxStartedTime=${period.to}&$top=500&api-version=${API}`;
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        items: [],
        notes: [`Azure Releases ${res.status} ${url}: ${body.slice(0, 200)}`],
        unavailableFields: [],
      };
    }
    const body = (await res.json()) as DeploymentsResponse;
    const items: Deployment[] = (body.value ?? []).map((d) => {
      const env = d.releaseEnvironment?.name ?? 'unknown';
      const reason = (d.reason ?? '').toLowerCase();
      const name = (d.release?.name ?? '').toLowerCase();
      return {
        id: String(d.id),
        environment: env,
        deployedAt: d.startedOn ?? period.from,
        succeeded: (d.deploymentStatus ?? '').toLowerCase() === 'succeeded',
        isRollback: reason.includes('rollback') || name.includes('rollback'),
        isHotfix: name.includes('hotfix') || name.includes('patch'),
        releaseId: d.release?.id === undefined ? null : String(d.release.id),
      };
    });
    return {
      items,
      notes: [
        `Loaded ${items.length} deployments from Azure Releases.`,
        'Rollback / hotfix detection is name-and-reason based (M4.3 v2). Tighten it by tagging hotfix pipelines explicitly.',
      ],
      unavailableFields: [],
    };
  }

  async fetchTestRuns(profile: ProjectProfile, period: Period): Promise<CollectResult<TestRun>> {
    const url = `${this.base(profile)}/_apis/test/runs?minLastUpdatedDate=${period.from}&maxLastUpdatedDate=${period.to}&$top=500&api-version=${API}`;
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        items: [],
        notes: [`Azure Test Runs ${res.status} ${url}: ${body.slice(0, 200)}`, 'Q16 will be partial.'],
        unavailableFields: [],
      };
    }
    const body = (await res.json()) as TestRunsResponse;
    const items: TestRun[] = (body.value ?? []).map((r) => {
      const total = r.totalTests ?? 0;
      const passed = r.passedTests ?? 0;
      const skipped = r.notApplicableTests ?? 0;
      const started = r.startedDate ?? period.from;
      const completed = r.completedDate ?? started;
      return {
        id: String(r.id),
        pipeline: r.name ?? 'unknown',
        commitSha: r.buildConfiguration?.sourceVersion ?? null,
        startedAt: started,
        durationSeconds: Math.max(0, (Date.parse(completed) - Date.parse(started)) / 1000),
        total,
        passed,
        failed: Math.max(0, total - passed - skipped),
        skipped,
        tasFailures: 0,
        inconclusive: r.unanalyzedTests ?? 0,
        retriedToGreen: 0,
        isRerun: false,
      };
    });
    return {
      items,
      notes: [
        `Loaded ${items.length} test runs from Azure Test.`,
        'tasFailures and retriedToGreen are 0 here: the ADO API cannot express them. Q16 will understate flakiness until the runner reports failure class - see reporters/.',
      ],
      unavailableFields: ['tasFailures', 'retriedToGreen'],
    };
  }
}

/** Combines two CI sources: deployments from one, test runs from another. */
export class CompositeCi implements CiPort {
  readonly kind = 'composite';
  constructor(
    private readonly deploymentSource: CiPort,
    private readonly testRunSource: CiPort,
  ) {}
  async fetchDeployments(profile: ProjectProfile, period: Period): Promise<CollectResult<Deployment>> {
    return this.deploymentSource.fetchDeployments(profile, period);
  }
  async fetchTestRuns(profile: ProjectProfile, period: Period): Promise<CollectResult<TestRun>> {
    return this.testRunSource.fetchTestRuns(profile, period);
  }
}
