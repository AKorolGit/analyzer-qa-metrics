import type { CollectResult, Period, TrackerPort } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { FieldChange, RawDefect, Release, Sprint, StateCategory } from '../../domain/types.js';

/**
 * Synthetic tracker used to exercise the pipeline without credentials.
 * The data carries deliberately planted pathologies so the diagnostic engine
 * has something real to find. Nothing here is used against a live project.
 */

let seed = 42;
function rnd(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
const iso = (d: Date): string => d.toISOString();
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

const COMPONENTS = ['billing', 'auth', 'trading', 'reporting', 'notifications', 'admin'] as const;
const ROOT_CAUSES = [
  'Missed Requirement',
  'Misinterpreted Requirement',
  'Human error during coding',
  'Failure to consider edge cases',
  'Configuration Error',
  'Environment Differences',
  '3rd party issue',
] as const;

export class FixtureTracker implements TrackerPort {
  readonly kind = 'fixture';

  async fetchDefects(profile: ProjectProfile, period: Period): Promise<CollectResult<RawDefect>> {
    seed = 42;
    const from = new Date(period.from);
    const to = new Date(period.to);
    const span = (to.getTime() - from.getTime()) / 86_400_000;
    const defects: RawDefect[] = [];
    const count = 420;

    for (let i = 0; i < count; i += 1) {
      const created = addDays(from, Math.floor(rnd() * span));
      // Planted pathology 1: billing is a hotspot (30% of defects).
      const component = rnd() < 0.3 ? 'billing' : pick(COMPONENTS);
      // Planted pathology 2: production defects are under-tagged in the second half.
      const isProdReality = rnd() < 0.22;
      const late = created.getTime() > from.getTime() + (span / 2) * 86_400_000;
      const tagged = isProdReality && (late ? rnd() < 0.55 : rnd() < 0.9);
      // Planted pathology 3: priority is left at the default on a third of defects.
      const priority = rnd() < 0.33 ? '2' : pick(['1', '2', '3', '4']);
      const priorityTouched = priority !== '2' || rnd() < 0.2;
      const resolvedAfter = 1 + Math.floor(rnd() * (priority === '1' ? 6 : 40));
      const resolved = rnd() < 0.82 ? addDays(created, resolvedAfter) : null;
      // Planted pathology 4: reopen rate is high in billing.
      const reopened = resolved !== null && (component === 'billing' ? rnd() < 0.24 : rnd() < 0.07);
      const rejected = rnd() < 0.11;
      const history: FieldChange[] = [];
      if (priorityTouched) {
        history.push({ field: 'priority', from: '2', to: priority, at: iso(addDays(created, 0.4)), by: 'triage' });
      }
      history.push({ field: 'stateCategory', from: 'new', to: 'active', at: iso(addDays(created, 0.5)), by: 'triage' });
      if (resolved !== null) {
        history.push({ field: 'stateCategory', from: 'active', to: 'resolved', at: iso(resolved), by: 'dev' });
        if (reopened) {
          history.push({ field: 'stateCategory', from: 'resolved', to: 'active', at: iso(addDays(resolved, 2)), by: 'qa' });
        }
      }
      const sprintIdx = Math.floor((created.getTime() - from.getTime()) / (14 * 86_400_000));
      // Planted pathology 5: fixes are planned 2+ sprints after detection.
      const plannedSprint = `Sprint ${sprintIdx + (rnd() < 0.4 ? 2 : rnd() < 0.7 ? 1 : 0)}`;
      history.push({ field: 'iterationPath', from: null, to: plannedSprint, at: iso(addDays(created, 1)), by: 'pm' });

      const stateCategory: StateCategory = resolved === null ? 'active' : reopened ? 'active' : 'closed';
      // Root cause only filled for high priority, and skewed towards coding.
      const fillCause = (priority === '1' || priority === '2') && rnd() < 0.75;

      defects.push({
        id: String(1000 + i),
        key: `BUG-${1000 + i}`,
        url: null,
        title: `${component} issue ${i}`,
        description: 'synthetic',
        reproSteps: rnd() < 0.8 ? 'steps' : null,
        createdAt: iso(created),
        activatedAt: iso(addDays(created, 0.5)),
        resolvedAt: resolved === null ? null : iso(resolved),
        closedAt: resolved === null || reopened ? null : iso(addDays(resolved, 1)),
        state: stateCategory,
        stateCategory,
        resolution: resolved === null ? null : rejected ? pick(['Not a defect', 'By design', 'Duplicate']) : 'Fixed',
        severity: null, // planted pathology 6: severity is not maintained at all
        priority,
        component,
        areaPath: `Product\\${component}`,
        iterationPath: plannedSprint,
        versionDetected: null,
        versionCorrected: null,
        environmentField: null,
        rootCause: fillCause ? pick(ROOT_CAUSES) : null,
        createdBy: pick(['qa1', 'qa2', 'dev1', 'support']),
        assignedTo: pick(['qa1', 'qa2', 'dev1', 'dev2']),
        tags: tagged ? ['Prod'] : rnd() < 0.1 ? ['Hotfix'] : [],
        links: rnd() < 0.45 ? [{ type: 'Parent', id: `US-${2000 + Math.floor(rnd() * 300)}` }] : [],
        commits: rnd() < 0.3 ? [`sha${i}`] : [],
        pullRequests: rnd() < 0.35 ? [`PR-${i}`] : [],
        history,
        source: 'fixture',
      });
    }
    void profile;
    return {
      items: defects,
      notes: [`Fixture tracker generated ${defects.length} synthetic defects. NOT real project data.`],
      unavailableFields: ['severity', 'environmentField', 'versionDetected'],
    };
  }

  async fetchReleases(_profile: ProjectProfile, period: Period): Promise<CollectResult<Release>> {
    const from = new Date(period.from);
    const span = (new Date(period.to).getTime() - from.getTime()) / 86_400_000;
    const step = span / 9;
    const releases: Release[] = [];
    for (let i = 0; i < 8; i += 1) {
      const version = `1.${40 + i}.0`;
      releases.push({
        id: `rel-${i}`,
        version,
        isPatch: false,
        cohort: `1.${40 + i}`,
        releasedAt: iso(addDays(from, step * (i + 1))),
        klocChanged: 3 + i * 0.4,
        storiesDelivered: 12 + i,
        deployments: 1,
      });
    }
    return { items: releases, notes: ['Fixture releases, 3-week cadence.'], unavailableFields: [] };
  }

  async fetchSprints(_profile: ProjectProfile, period: Period): Promise<CollectResult<Sprint>> {
    const from = new Date(period.from);
    const sprints: Sprint[] = [];
    for (let i = 0; i < 26; i += 1) {
      sprints.push({
        name: `Sprint ${i}`,
        startsAt: iso(addDays(from, i * 14)),
        endsAt: iso(addDays(from, i * 14 + 13)),
        releaseId: `rel-${Math.min(7, Math.floor((i * 14) / 21))}`,
      });
    }
    return { items: sprints, notes: [], unavailableFields: [] };
  }
}
