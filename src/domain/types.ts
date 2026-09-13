/**
 * Normalised domain model. Every tracker adapter must produce RawDefect;
 * everything downstream knows nothing about ADO or Jira.
 */

export type Iso = string;

export type StateCategory = 'new' | 'active' | 'resolved' | 'closed' | 'removed';

export interface FieldChange {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly at: Iso;
  readonly by: string | null;
}

export interface LinkRef {
  readonly type: string;
  readonly id: string;
}

/** Exactly what a tracker adapter returns. No derived values here. */
export interface RawDefect {
  readonly id: string;
  readonly key: string;
  readonly url: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly reproSteps: string | null;
  readonly createdAt: Iso;
  readonly activatedAt: Iso | null;
  readonly resolvedAt: Iso | null;
  readonly closedAt: Iso | null;
  readonly state: string;
  readonly stateCategory: StateCategory;
  readonly resolution: string | null;
  readonly severity: string | null;
  readonly priority: string | null;
  readonly component: string | null;
  readonly areaPath: string | null;
  readonly iterationPath: string | null;
  readonly versionDetected: string | null;
  readonly versionCorrected: string | null;
  readonly environmentField: string | null;
  readonly rootCause: string | null;
  readonly createdBy: string | null;
  readonly assignedTo: string | null;
  readonly tags: readonly string[];
  readonly links: readonly LinkRef[];
  readonly commits: readonly string[];
  readonly pullRequests: readonly string[];
  readonly history: readonly FieldChange[];
  readonly source: TrackerKind;
}

export type TrackerKind = 'azure-devops' | 'jira' | 'fixture';
export type VcsKind = 'github' | 'local-git' | 'none';

export interface Release {
  readonly id: string;
  readonly version: string;
  /** X.Y.0 is a base release; X.Y.N (N>0) is a patch of cohort X.Y (M1). */
  readonly isPatch: boolean;
  readonly cohort: string;
  readonly releasedAt: Iso;
  readonly klocChanged: number | null;
  readonly storiesDelivered: number | null;
  readonly deployments: number | null;
}

export interface Sprint {
  readonly name: string;
  readonly startsAt: Iso;
  readonly endsAt: Iso;
  readonly releaseId: string | null;
}

export interface Deployment {
  readonly id: string;
  readonly environment: string;
  readonly deployedAt: Iso;
  readonly succeeded: boolean;
  readonly isRollback: boolean;
  readonly isHotfix: boolean;
  readonly releaseId: string | null;
}

export interface CommitInfo {
  readonly sha: string;
  readonly authoredAt: Iso;
  readonly message: string;
  readonly files: readonly string[];
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly pullRequest: string | null;
}

export interface TestRun {
  readonly id: string;
  readonly pipeline: string;
  readonly commitSha: string | null;
  readonly startedAt: Iso;
  readonly durationSeconds: number;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** TAE 6.1.1: failure of the automation, not of the SUT. */
  readonly tasFailures: number;
  /** TAE 7.1.3: green but asserted nothing. */
  readonly inconclusive: number;
  readonly retriedToGreen: number;
  readonly isRerun: boolean;
}

/** Everything a collector run captured, before any derivation. */
export interface Snapshot {
  readonly runId: string;
  readonly collectedAt: Iso;
  readonly profileName: string;
  readonly period: { readonly from: Iso; readonly to: Iso };
  readonly defects: readonly RawDefect[];
  readonly releases: readonly Release[];
  readonly sprints: readonly Sprint[];
  readonly deployments: readonly Deployment[];
  readonly commits: readonly CommitInfo[];
  readonly testRuns: readonly TestRun[];
  readonly sourceNotes: readonly string[];
}
