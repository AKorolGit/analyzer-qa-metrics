import type {
  CommitInfo,
  Deployment,
  Iso,
  RawDefect,
  Release,
  Snapshot,
  Sprint,
  TestRun,
} from '../domain/types.js';
import type { ProjectProfile } from '../domain/profile.js';

export interface Period {
  readonly from: Iso;
  readonly to: Iso;
}

/** Ports. Adapters implement these; the core never imports an adapter. */

export interface TrackerPort {
  readonly kind: string;
  /** Human-readable notes about what was and was not available. */
  fetchDefects(profile: ProjectProfile, period: Period): Promise<CollectResult<RawDefect>>;
  fetchReleases(profile: ProjectProfile, period: Period): Promise<CollectResult<Release>>;
  fetchSprints(profile: ProjectProfile, period: Period): Promise<CollectResult<Sprint>>;
}

export interface VcsPort {
  readonly kind: string;
  fetchCommits(profile: ProjectProfile, period: Period): Promise<CollectResult<CommitInfo>>;
}

export interface CiPort {
  readonly kind: string;
  fetchDeployments(profile: ProjectProfile, period: Period): Promise<CollectResult<Deployment>>;
  fetchTestRuns(profile: ProjectProfile, period: Period): Promise<CollectResult<TestRun>>;
}

export interface CollectResult<T> {
  readonly items: readonly T[];
  readonly notes: readonly string[];
  /** Fields the source could not supply at all. Feeds the fitness gate. */
  readonly unavailableFields: readonly string[];
}

export interface SnapshotStorePort {
  /** Writes an immutable snapshot; returns the path. Never overwrites. */
  saveSnapshot(snapshot: Snapshot): Promise<string>;
  loadSnapshot(runId: string): Promise<Snapshot>;
  latestRunId(): Promise<string | null>;
  /** Writes a report under a new timestamped name. Never overwrites. */
  saveReport(runId: string, extension: string, content: string): Promise<string>;
  appendRunLedger(entry: Readonly<Record<string, unknown>>): Promise<void>;
}
