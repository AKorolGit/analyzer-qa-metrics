import { randomUUID } from 'node:crypto';
import type { CiPort, SnapshotStorePort, TrackerPort, VcsPort } from '../ports/index.js';
import type { ProjectProfile } from '../domain/profile.js';
import type { Snapshot } from '../domain/types.js';
import {
  applyScope,
  envMarkerAgreement,
  normalize,
  type EnvMarkerAgreement,
  type ScopeResult,
} from './normalize/index.js';
import { assessFitness } from './fitness/index.js';
import { computeAll } from './metrics/registry.js';
import { diagnose } from './diagnostics/engine.js';
import { renderMarkdown } from './report/markdown.js';
import { loadManualInputs } from './manual-inputs-loader.js';
import { EMPTY_MANUAL_INPUTS, type ManualInputs } from '../domain/manual-inputs.js';
import type { MetricResult } from './metrics/contract.js';
import type { Diagnosis } from './diagnostics/engine.js';

export interface Analysis {
  readonly snapshot: Snapshot;
  readonly metrics: readonly MetricResult[];
  readonly diagnosis: Diagnosis;
  readonly fitness: ReturnType<typeof assessFitness>;
  readonly scope: ScopeResult;
  readonly envAgreement: EnvMarkerAgreement;
  readonly envSources: Readonly<Record<string, number>>;
  readonly impSources: Readonly<Record<string, number>>;
  readonly cohortSources: Readonly<Record<string, number>>;
}

export async function loadInputs(profile: ProjectProfile): Promise<ManualInputs> {
  return loadManualInputs(profile);
}

export function runId(profile: ProjectProfile, at: Date): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${profile.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${randomUUID().slice(0, 6)}`;
}

export async function collect(
  profile: ProjectProfile,
  tracker: TrackerPort,
  vcs: VcsPort | null,
  ci: CiPort | null,
  store: SnapshotStorePort,
  now: Date = new Date(),
): Promise<Snapshot> {
  const period = profile.period;
  const notes: string[] = [];

  const defects = await tracker.fetchDefects(profile, period);
  const releases = await tracker.fetchReleases(profile, period);
  const sprints = await tracker.fetchSprints(profile, period);
  const commits = vcs === null ? { items: [], notes: ['No VCS configured.'], unavailableFields: [] } : await vcs.fetchCommits(profile, period);
  const deployments = ci === null ? { items: [], notes: [], unavailableFields: [] } : await ci.fetchDeployments(profile, period);
  const testRuns = ci === null ? { items: [], notes: [], unavailableFields: [] } : await ci.fetchTestRuns(profile, period);

  notes.push(
    ...defects.notes,
    ...releases.notes,
    ...sprints.notes,
    ...commits.notes,
    ...deployments.notes,
    ...testRuns.notes,
  );
  const unavailable = [...defects.unavailableFields, ...commits.unavailableFields];
  if (unavailable.length > 0) {
    notes.push(`Fields the source could not supply at all: ${[...new Set(unavailable)].join(', ')}.`);
  }

  const snapshot: Snapshot = {
    runId: runId(profile, now),
    collectedAt: now.toISOString(),
    profileName: profile.name,
    period,
    defects: defects.items,
    releases: releases.items,
    sprints: sprints.items,
    deployments: deployments.items,
    commits: commits.items,
    testRuns: testRuns.items,
    sourceNotes: notes,
  };
  await store.saveSnapshot(snapshot);
  return snapshot;
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function analyse(
  snapshot: Snapshot,
  profile: ProjectProfile,
  now: Date = new Date(),
  manual: ManualInputs = EMPTY_MANUAL_INPUTS,
): Analysis {
  // Scope first: fitness must describe the population the metrics run on,
  // not the raw dump. Measuring completeness on defects you then discard
  // produces a Q1 that belongs to nobody.
  const scope = applyScope(snapshot.defects, profile);
  const fitness = assessFitness(scope.included, profile);
  const defects = normalize(scope.included, snapshot.releases, snapshot.sprints, profile, now);
  const metrics = computeAll({ snapshot, defects, profile, fitness, manual, now });
  const diagnosis = diagnose(metrics, profile);
  return {
    snapshot,
    metrics,
    diagnosis,
    fitness,
    scope,
    envAgreement: envMarkerAgreement(defects, profile),
    envSources: tally(defects.map((d) => d.envSource)),
    impSources: tally(defects.map((d) => d.impSource)),
    cohortSources: tally(defects.map((d) => d.cohortSource)),
  };
}

export async function report(
  analysis: Analysis,
  profile: ProjectProfile,
  store: SnapshotStorePort,
  now: Date = new Date(),
): Promise<{ markdownPath: string; jsonPath: string }> {
  const markdown = renderMarkdown({
    snapshot: analysis.snapshot,
    profile,
    fitness: analysis.fitness,
    metrics: analysis.metrics,
    diagnosis: analysis.diagnosis,
    scope: analysis.scope,
    envAgreement: analysis.envAgreement,
    envSources: analysis.envSources,
    impSources: analysis.impSources,
    cohortSources: analysis.cohortSources,
    generatedAt: now,
  });
  const markdownPath = await store.saveReport(analysis.snapshot.runId, 'md', markdown);
  const jsonPath = await store.saveReport(
    analysis.snapshot.runId,
    'json',
    JSON.stringify(
      {
        runId: analysis.snapshot.runId,
        generatedAt: now.toISOString(),
        profile: { name: profile.name, versions: profile.versions, windowDays: profile.windowDays },
        scope: { ...analysis.scope, included: analysis.scope.included.length },
        envAgreement: analysis.envAgreement,
        envSources: analysis.envSources,
        impSources: analysis.impSources,
        cohortSources: analysis.cohortSources,
        fitness: analysis.fitness,
        metrics: analysis.metrics,
        diagnosis: analysis.diagnosis,
      },
      null,
      2,
    ),
  );
  await store.appendRunLedger({
    runId: analysis.snapshot.runId,
    generatedAt: now.toISOString(),
    profile: profile.name,
    period: profile.period,
    defectsCollected: analysis.snapshot.defects.length,
    defectsInScope: analysis.scope.included.length,
    q1: analysis.fitness.q1,
    prodMarked: analysis.envAgreement.markedTotal,
    envMarkerDisagreement: analysis.envAgreement.disagreementRate,
    findings: analysis.diagnosis.findings.length,
    criticalFindings: analysis.diagnosis.findings.filter((f) => f.severity === 'critical').length,
    markdownPath,
    jsonPath,
  });
  return { markdownPath, jsonPath };
}