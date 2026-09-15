import type { CollectResult, Period, TrackerPort } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { FieldChange, LinkRef, RawDefect, Release, Sprint, StateCategory } from '../../domain/types.js';
import { projectUrl } from './ado-url.js';

const API = '7.1';

interface WiqlResponse { workItems?: { id: number }[] }
interface WorkItem {
  id: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string; attributes?: Record<string, unknown> }[];
  _links?: { html?: { href?: string } };
}
interface BatchResponse { value?: WorkItem[] }
interface FieldListResponse { value?: { referenceName: string; name?: string }[] }
interface UpdatesResponse {
  value?: {
    revisedDate?: string;
    revisedBy?: { displayName?: string };
    fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
  }[];
}
interface IterationsResponse {
  value?: { name: string; path?: string; attributes?: { startDate?: string; finishDate?: string } }[];
}

const F = {
  title: 'System.Title',
  state: 'System.State',
  createdDate: 'System.CreatedDate',
  changedDate: 'System.ChangedDate',
  closedDate: 'Microsoft.VSTS.Common.ClosedDate',
  resolvedDate: 'Microsoft.VSTS.Common.ResolvedDate',
  activatedDate: 'Microsoft.VSTS.Common.ActivatedDate',
  severity: 'Microsoft.VSTS.Common.Severity',
  priority: 'Microsoft.VSTS.Common.Priority',
  areaPath: 'System.AreaPath',
  iterationPath: 'System.IterationPath',
  tags: 'System.Tags',
  createdBy: 'System.CreatedBy',
  assignedTo: 'System.AssignedTo',
  reason: 'System.Reason',
  repro: 'Microsoft.VSTS.TCM.ReproSteps',
  description: 'System.Description',
  rootCause: 'Custom.RootCause',
  foundIn: 'Microsoft.VSTS.Build.FoundIn',
  integrationBuild: 'Microsoft.VSTS.Build.IntegrationBuild',
  environment: '',
  component: '',
} as const;

/** Requested on every run; these exist on any ADO instance. */
const CORE_FIELDS: readonly string[] = [
  F.title,
  F.state,
  F.createdDate,
  F.changedDate,
  F.closedDate,
  F.resolvedDate,
  F.activatedDate,
  F.priority,
  F.areaPath,
  F.iterationPath,
  F.tags,
  F.createdBy,
  F.assignedTo,
  F.reason,
  F.description,
];

export type OverridableField =
  | 'severity'
  | 'rootCause'
  | 'environment'
  | 'repro'
  | 'versionDetected'
  | 'versionCorrected'
  | 'component';

export type FieldOverrides = Partial<Record<OverridableField, string>>;

/**
 * Guesses, used only when the profile does not override them. Every one of
 * these is instance-specific: `Custom.RootCause` is a plausible name, not a
 * guaranteed one. They are filtered against the real field list before use.
 */
const DEFAULTS: Record<OverridableField, string> = {
  severity: F.severity,
  rootCause: F.rootCause,
  environment: F.environment,
  repro: F.repro,
  versionDetected: F.foundIn,
  versionCorrected: F.integrationBuild,
  component: F.component,
};

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'displayName' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['displayName']);
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

function stateCategory(state: string | null): StateCategory {
  const s = (state ?? '').toLowerCase();
  if (s === 'new' || s === 'proposed') return 'new';
  if (s === 'active' || s === 'committed' || s === 'in progress' || s === 'approved') return 'active';
  if (s === 'resolved') return 'resolved';
  if (s === 'closed' || s === 'done') return 'closed';
  if (s === 'removed') return 'removed';
  return 'active';
}

const overlaps = (start: string, end: string, period: Period): boolean =>
  Date.parse(start) <= Date.parse(period.to) && Date.parse(end) >= Date.parse(period.from);

export class AzureDevOpsTracker implements TrackerPort {
  readonly kind = 'azure-devops';

  /** Reference names this instance actually defines. Populated once per run. */
  private knownFields: Set<string> | null = null;

  constructor(
    private readonly pat: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly overrides: FieldOverrides = {},
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`:${this.pat}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }

  /** `{collection}/{project}` - every WIQL and work-item call hangs off this. */
  private base(profile: ProjectProfile): string {
    return projectUrl(profile.tracker.baseUrl, profile.tracker.organization, profile.tracker.project);
  }

  private ref(name: OverridableField): string {
    const override = this.overrides[name];
    return override === undefined || override === '' ? DEFAULTS[name] : override;
  }

  /**
   * Accepts either a path relative to `{collection}/{project}` or an absolute
   * URL, so continuation links from the API can be followed as-is.
   *
   * The response body is included in the error on purpose: ADO answers 4xx with
   * a JSON `message` naming the actual cause (bad project, missing PAT scope,
   * a field that does not exist). Status text alone sends you debugging the
   * wrong thing.
   */
  private async ado<T>(profile: ProjectProfile, path: string, init?: RequestInit): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.base(profile)}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers(), ...((init?.headers as Record<string, string>) ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ADO ${res.status} ${res.statusText} ${url}\n${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * The instance's field dictionary.
   *
   * Naming a field that does not exist makes `workitemsbatch` fail with TF51535
   * for the WHOLE batch - one bad guess in the profile kills the entire
   * collection. Asking first turns that hard failure into a note.
   */
  private async loadKnownFields(profile: ProjectProfile): Promise<Set<string>> {
    if (this.knownFields !== null) return this.knownFields;
    try {
      const res = await this.ado<FieldListResponse>(profile, `/_apis/wit/fields?api-version=${API}`);
      this.knownFields = new Set((res.value ?? []).map((f) => f.referenceName));
    } catch {
      // Without the dictionary the safe move is to request nothing optional.
      this.knownFields = new Set(CORE_FIELDS);
    }
    return this.knownFields;
  }

  /**
   * Fields to request: core plus any configured custom field that this instance
   * actually defines. Unknown names are dropped here and reported as notes, so
   * a stale override degrades one metric instead of failing the run.
   */
  private resolveRequestedFields(known: Set<string>): { fields: string[]; missing: [string, string][] } {
    const missing: [string, string][] = [];
    const custom: string[] = [];
    for (const name of Object.keys(DEFAULTS) as OverridableField[]) {
      const reference = this.ref(name);
      if (reference === '') continue;
      if (known.has(reference)) custom.push(reference);
      else if (this.overrides[name] !== undefined) missing.push([name, reference]);
      // A DEFAULT that does not exist is not worth reporting: it was a guess,
      // and the profile never claimed the field was there.
    }
    return { fields: [...new Set([...CORE_FIELDS.filter((f) => known.has(f)), ...custom])], missing };
  }

  /**
   * Diagnostic: which fields actually exist on this project's bugs, and how
   * often they are filled. Answers "what is our Root Cause field really called"
   * with evidence rather than a guess.
   */
  async discoverFields(
    profile: ProjectProfile,
    period: Period,
    sampleSize = 200,
  ): Promise<{ field: string; filled: number; sample: string | null }[]> {
    const wiql = `SELECT [System.Id] FROM WorkItems
       WHERE [System.WorkItemType] = 'Bug'
         AND [System.CreatedDate] >= '${period.from.slice(0, 10)}'
       ORDER BY [System.Id] DESC`;
    const query = await this.ado<WiqlResponse>(profile, `/_apis/wit/wiql?api-version=${API}`, {
      method: 'POST',
      body: JSON.stringify({ query: wiql }),
    });
    const ids = (query.workItems ?? []).slice(0, sampleSize).map((w) => w.id);
    if (ids.length === 0) return [];

    const counts = new Map<string, { filled: number; sample: string | null }>();
    for (let i = 0; i < ids.length; i += 200) {
      // Neither `fields` nor `$expand`: this call must return whatever the work
      // item happens to carry.
      const batch = await this.ado<BatchResponse>(profile, `/_apis/wit/workitemsbatch?api-version=${API}`, {
        method: 'POST',
        body: JSON.stringify({ ids: ids.slice(i, i + 200) }),
      });
      for (const wi of batch.value ?? []) {
        for (const [name, value] of Object.entries(wi.fields)) {
          const text = str(value);
          const cur = counts.get(name) ?? { filled: 0, sample: null };
          if (text !== null) {
            cur.filled += 1;
            if (cur.sample === null) cur.sample = text.slice(0, 60);
          }
          counts.set(name, cur);
        }
      }
    }
    return [...counts.entries()]
      .map(([field, v]) => ({ field, filled: v.filled / ids.length, sample: v.sample }))
      .sort((a, b) => b.filled - a.filled);
  }

  async fetchDefects(profile: ProjectProfile, period: Period): Promise<CollectResult<RawDefect>> {
    const notes: string[] = [];
    const known = await this.loadKnownFields(profile);
    const { fields, missing } = this.resolveRequestedFields(known);

    for (const [name, reference] of missing) {
      notes.push(
        `CONFIG ERROR: fieldOverrides.${name} = "${reference}" is not defined on this instance and was not requested. Run \`npm run fields\` and use a reference name from that list, or remove the override.`,
      );
    }

    const wiql =
      profile.tracker.wiql ??
      `SELECT [System.Id] FROM WorkItems
       WHERE [System.WorkItemType] = 'Bug'
         AND [System.CreatedDate] >= '${period.from.slice(0, 10)}'
         AND [System.CreatedDate] <= '${period.to.slice(0, 10)}'
       ORDER BY [System.Id]`;

    const query = await this.ado<WiqlResponse>(profile, `/_apis/wit/wiql?api-version=${API}`, {
      method: 'POST',
      body: JSON.stringify({ query: wiql }),
    });
    const ids = (query.workItems ?? []).map((w) => w.id);
    // Resolved URL is logged because a wrong collection is the single most
    // common setup failure, and a 404 alone does not say which part was wrong.
    notes.push(`Project endpoint: ${this.base(profile)}/_apis`);
    notes.push(`WIQL returned ${ids.length} bugs.`);

    const items: RawDefect[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);

      // Two passes, because ADO rejects `fields` together with `$expand`.
      // Pass 1 names every field we need, including custom ones - without this
      // the API returns its default set and silently omits custom fields.
      const byField = await this.ado<BatchResponse>(profile, `/_apis/wit/workitemsbatch?api-version=${API}`, {
        method: 'POST',
        body: JSON.stringify({ ids: chunk, fields }),
      });
      // Pass 2 fetches relations, which carry commit and PR links (Q3).
      const byRelation = await this.ado<BatchResponse>(profile, `/_apis/wit/workitemsbatch?api-version=${API}`, {
        method: 'POST',
        body: JSON.stringify({ ids: chunk, $expand: 'relations' }),
      });
      const relations = new Map((byRelation.value ?? []).map((wi) => [wi.id, wi]));

      for (const wi of byField.value ?? []) {
        const withLinks = relations.get(wi.id);
        items.push(
          this.toDefect({
            ...wi,
            relations: withLinks?.relations ?? [],
            _links: withLinks?._links ?? wi._links,
          }),
        );
      }
    }

    // Field history is required by completeness v1 and by Imp v2/v4.
    let historyFetched = 0;
    const withHistory: RawDefect[] = [];
    for (const d of items) {
      try {
        const updates = await this.ado<UpdatesResponse>(
          profile,
          `/_apis/wit/workItems/${d.id}/updates?api-version=${API}`,
        );
        withHistory.push({ ...d, history: this.toHistory(updates) });
        historyFetched += 1;
      } catch {
        withHistory.push(d);
      }
    }
    notes.push(`Revision history fetched for ${historyFetched}/${items.length} bugs.`);

    const unavailable: string[] = [];
    if (withHistory.every((d) => d.severity === null)) unavailable.push('severity');
    if (withHistory.every((d) => d.environmentField === null)) unavailable.push('environmentField');
    if (withHistory.every((d) => d.rootCause === null)) unavailable.push('rootCause');
    if (withHistory.every((d) => d.versionDetected === null)) unavailable.push('versionDetected');
    if (withHistory.every((d) => d.versionCorrected === null)) unavailable.push('versionCorrected');
    if (unavailable.length > 0) {
      notes.push(
        `Empty on every bug: ${unavailable.join(', ')}. Either the field is not maintained on this project, or it is not defined at all.`,
      );
    }
    notes.push(
      `Field mapping in use: ${(Object.keys(DEFAULTS) as OverridableField[])
        .map((k) => {
          const reference = this.ref(k);
          if (reference === '') return `${k}=(none)`;
          return `${k}=${reference}${known.has(reference) ? '' : ' [NOT ON THIS INSTANCE]'}`;
        })
        .join(', ')}`,
    );

    return { items: withHistory, notes, unavailableFields: unavailable };
  }

  private toDefect(wi: WorkItem): RawDefect {
    const f = wi.fields;
    const tags = (str(f[F.tags]) ?? '').split(';').map((t) => t.trim()).filter((t) => t !== '');
    const links: LinkRef[] = [];
    const commits: string[] = [];
    const pullRequests: string[] = [];
    for (const rel of wi.relations ?? []) {
      if (rel.rel === 'ArtifactLink') {
        if (rel.url.includes('/Commit/')) commits.push(decodeURIComponent(rel.url.split('/').pop() ?? ''));
        else if (rel.url.includes('/PullRequestId/')) pullRequests.push(decodeURIComponent(rel.url.split('/').pop() ?? ''));
      } else if (rel.rel.startsWith('System.LinkTypes')) {
        const name = String(rel.attributes?.['name'] ?? rel.rel);
        links.push({ type: name, id: rel.url.split('/').pop() ?? '' });
      }
    }
    const state = str(f[F.state]);
    const componentRef = this.ref('component');
    return {
      id: String(wi.id),
      key: String(wi.id),
      url: wi._links?.html?.href ?? null,
      title: str(f[F.title]) ?? '',
      description: str(f[F.description]),
      reproSteps: str(f[this.ref('repro')]),
      createdAt: str(f[F.createdDate]) ?? new Date(0).toISOString(),
      activatedAt: str(f[F.activatedDate]),
      resolvedAt: str(f[F.resolvedDate]),
      closedAt: str(f[F.closedDate]),
      state: state ?? '',
      stateCategory: stateCategory(state),
      resolution: str(f[F.reason]),
      severity: str(f[this.ref('severity')]),
      priority: str(f[F.priority]),
      component: componentRef === '' ? null : str(f[componentRef]),
      areaPath: str(f[F.areaPath]),
      iterationPath: str(f[F.iterationPath]),
      versionDetected: str(f[this.ref('versionDetected')]),
      versionCorrected: str(f[this.ref('versionCorrected')]),
      environmentField: str(f[this.ref('environment')]),
      rootCause: str(f[this.ref('rootCause')]),
      createdBy: str(f[F.createdBy]),
      assignedTo: str(f[F.assignedTo]),
      tags,
      links,
      commits,
      pullRequests,
      history: [],
      source: 'azure-devops',
    };
  }

  private toHistory(updates: UpdatesResponse): readonly FieldChange[] {
    const map: Record<string, string> = {
      [F.state]: 'stateCategory',
      [F.priority]: 'priority',
      [F.assignedTo]: 'assignedTo',
      [F.iterationPath]: 'iterationPath',
      [F.areaPath]: 'areaPath',
      [F.tags]: 'tags',
      [this.ref('severity')]: 'severity',
      [this.ref('rootCause')]: 'rootCause',
      [this.ref('environment')]: 'environmentField',
      [this.ref('versionDetected')]: 'versionDetected',
      [this.ref('versionCorrected')]: 'versionCorrected',
    };
    const out: FieldChange[] = [];
    for (const u of updates.value ?? []) {
      for (const [adoField, change] of Object.entries(u.fields ?? {})) {
        const domainField = map[adoField];
        if (domainField === undefined) continue;
        const to = str(change.newValue);
        out.push({
          field: domainField,
          from: str(change.oldValue),
          to: domainField === 'stateCategory' ? stateCategory(to) : to,
          at: u.revisedDate ?? new Date(0).toISOString(),
          by: u.revisedBy?.displayName ?? null,
        });
      }
    }
    return out;
  }

  async fetchReleases(profile: ProjectProfile, _period: Period): Promise<CollectResult<Release>> {
    const items: Release[] = profile.releases.map((r, i) => {
      const parts = r.version.split('.');
      const patch = Number.parseInt(parts[2] ?? '0', 10);
      return {
        id: `rel-${i}`,
        version: r.version,
        isPatch: Number.isFinite(patch) && patch > 0,
        cohort: `${parts[0] ?? '0'}.${parts[1] ?? '0'}`,
        releasedAt: r.releasedAt,
        klocChanged: r.klocChanged ?? null,
        storiesDelivered: r.storiesDelivered ?? null,
        deployments: null,
      };
    });
    const notes = ['Releases taken from the project profile, not from ADO. Keep config/profile.json under version control.'];
    if (items.length < 4) {
      notes.push(
        `Only ${items.length} release(s) defined. DDP and field-defect trends need at least 4-6 mature cohorts before a process behaviour chart says anything.`,
      );
    }
    return { items, notes, unavailableFields: [] };
  }

  async fetchSprints(profile: ProjectProfile, period: Period): Promise<CollectResult<Sprint>> {
    try {
      const res = await this.ado<IterationsResponse>(
        profile,
        `/_apis/work/teamsettings/iterations?api-version=${API}`,
      );
      const dated = (res.value ?? []).filter(
        (it) => it.attributes?.startDate != null && it.attributes?.finishDate != null,
      );
      // The endpoint returns every iteration the default team has ever had, not
      // the ones in our period. Filtering here keeps M4.9 sprint indices from
      // being diluted by years of unrelated history.
      const inPeriod = dated.filter((it) =>
        overlaps(it.attributes?.startDate as string, it.attributes?.finishDate as string, period),
      );
      const items: Sprint[] = inPeriod.map((it) => ({
        name: it.path ?? it.name,
        startsAt: it.attributes?.startDate as string,
        endsAt: it.attributes?.finishDate as string,
        releaseId: null,
      }));
      const notes = [
        `Iterations: ${res.value?.length ?? 0} returned by the default team, ${dated.length} with dates, ${items.length} overlapping the period.`,
      ];
      if (items.length > 0) {
        const first = items.reduce((a, b) => (Date.parse(a.startsAt) <= Date.parse(b.startsAt) ? a : b));
        const last = items.reduce((a, b) => (Date.parse(a.endsAt) >= Date.parse(b.endsAt) ? a : b));
        notes.push(`Sprint coverage: ${first.startsAt.slice(0, 10)} to ${last.endsAt.slice(0, 10)}.`);
      }
      notes.push(
        'Only the default team is queried. If bugs are planned by several teams, sprint-based metrics (M4.9) cover one team only.',
      );
      return { items, notes, unavailableFields: [] };
    } catch (error) {
      const items: Sprint[] = profile.sprints.map((s) => ({
        name: s.name,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        releaseId: null,
      }));
      return {
        items,
        notes: [`ADO iterations unavailable (${error instanceof Error ? error.message.split('\n')[0] : 'error'}); fell back to profile.`],
        unavailableFields: [],
      };
    }
  }
}