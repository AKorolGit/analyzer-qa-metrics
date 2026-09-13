import type { CollectResult, Period, TrackerPort } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { FieldChange, LinkRef, RawDefect, Release, Sprint, StateCategory } from '../../domain/types.js';

interface JiraSearchResponse {
  issues?: JiraIssue[];
  total?: number;
  startAt?: number;
}
interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: Record<string, unknown>;
  changelog?: {
    histories?: {
      created?: string;
      author?: { displayName?: string };
      items?: { field?: string; fieldId?: string; fromString?: string | null; toString?: string | null }[];
    }[];
  };
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const candidate = o['name'] ?? o['value'] ?? o['displayName'] ?? o['key'];
    if (candidate !== undefined) return String(candidate);
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

function stateCategory(key: string | null): StateCategory {
  switch ((key ?? '').toLowerCase()) {
    case 'new':
    case 'to do':
    case 'todo':
      return 'new';
    case 'done':
      return 'closed';
    case 'indeterminate':
    case 'in progress':
      return 'active';
    default:
      return 'active';
  }
}

/**
 * Jira adapter. Custom field IDs differ per instance, so they are read from
 * the profile's `fields` policy by name convention: any FieldPolicy whose
 * field is a domain name may carry `defaultValue` but the Jira id is resolved
 * from JIRA_FIELD_MAP env (JSON) - documented in README.
 */
export class JiraTracker implements TrackerPort {
  readonly kind = 'jira';

  constructor(
    private readonly email: string,
    private readonly apiToken: string,
    private readonly fieldMap: Readonly<Record<string, string>> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private mapped(fields: Record<string, unknown>, domainName: string): unknown {
    const id = this.fieldMap[domainName];
    return id === undefined ? undefined : fields[id];
  }

  async fetchDefects(profile: ProjectProfile, period: Period): Promise<CollectResult<RawDefect>> {
    const base = profile.tracker.baseUrl ?? '';
    const jql =
      profile.tracker.jql ??
      `project = "${profile.tracker.project ?? ''}" AND issuetype = Bug AND created >= "${period.from.slice(0, 10)}" AND created <= "${period.to.slice(0, 10)}" ORDER BY created ASC`;

    const items: RawDefect[] = [];
    const notes: string[] = [];
    let startAt = 0;
    let total = Number.POSITIVE_INFINITY;

    while (startAt < total) {
      const url = `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&expand=changelog`;
      const res = await this.fetchImpl(url, { headers: this.headers() });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Jira ${res.status} ${res.statusText} ${url}\n${body.slice(0, 300)}`);
      }
      const body = (await res.json()) as JiraSearchResponse;
      total = body.total ?? 0;
      for (const issue of body.issues ?? []) items.push(this.toDefect(issue, base));
      startAt += (body.issues ?? []).length;
      if ((body.issues ?? []).length === 0) break;
    }
    notes.push(`Jira JQL returned ${items.length} issues.`);

    const unavailable: string[] = [];
    if (items.every((d) => d.severity === null)) unavailable.push('severity');
    if (items.every((d) => d.environmentField === null)) unavailable.push('environmentField');
    if (items.every((d) => d.rootCause === null)) unavailable.push('rootCause');

    return { items, notes, unavailableFields: unavailable };
  }

  private toDefect(issue: JiraIssue, base: string): RawDefect {
    const f = issue.fields;
    const status = f['status'] as Record<string, unknown> | undefined;
    const category = status?.['statusCategory'] as Record<string, unknown> | undefined;
    const links: LinkRef[] = [];
    const parent = f['parent'] as Record<string, unknown> | undefined;
    if (parent !== undefined) links.push({ type: 'Parent', id: String(parent['key']) });
    for (const l of (f['issuelinks'] as Record<string, unknown>[] | undefined) ?? []) {
      const inward = l['inwardIssue'] as Record<string, unknown> | undefined;
      const outward = l['outwardIssue'] as Record<string, unknown> | undefined;
      const target = inward ?? outward;
      if (target !== undefined) {
        links.push({ type: String((l['type'] as Record<string, unknown> | undefined)?.['name'] ?? 'relates'), id: String(target['key']) });
      }
    }
    const versions = (f['versions'] as Record<string, unknown>[] | undefined) ?? [];
    const fixVersions = (f['fixVersions'] as Record<string, unknown>[] | undefined) ?? [];
    const created = str(f['created']) ?? new Date(0).toISOString();

    return {
      id: issue.id,
      key: issue.key,
      url: `${base}/browse/${issue.key}`,
      title: str(f['summary']) ?? '',
      description: str(f['description']),
      reproSteps: str(this.mapped(f, 'reproSteps')),
      createdAt: created,
      activatedAt: null,
      resolvedAt: str(f['resolutiondate']),
      closedAt: str(f['resolutiondate']),
      state: str(f['status']) ?? '',
      stateCategory: stateCategory(str(category?.['key'] ?? category?.['name'])),
      resolution: str(f['resolution']),
      severity: str(this.mapped(f, 'severity')),
      priority: str(f['priority']),
      component: ((f['components'] as Record<string, unknown>[] | undefined) ?? [])
        .map((c) => String(c['name']))
        .join(',') || null,
      areaPath: null,
      iterationPath: str(this.mapped(f, 'sprint')),
      versionDetected: versions[0] === undefined ? null : String(versions[0]['name']),
      versionCorrected: fixVersions[0] === undefined ? null : String(fixVersions[0]['name']),
      environmentField: str(f['environment']) ?? str(this.mapped(f, 'environment')),
      rootCause: str(this.mapped(f, 'rootCause')),
      createdBy: str(f['reporter']),
      assignedTo: str(f['assignee']),
      tags: (f['labels'] as string[] | undefined) ?? [],
      links,
      commits: [],
      pullRequests: [],
      history: this.toHistory(issue),
      source: 'jira',
    };
  }

  private toHistory(issue: JiraIssue): readonly FieldChange[] {
    const out: FieldChange[] = [];
    for (const h of issue.changelog?.histories ?? []) {
      for (const item of h.items ?? []) {
        const field = (item.fieldId ?? item.field ?? '').toLowerCase();
        const domainField =
          field === 'status'
            ? 'stateCategory'
            : field === 'priority'
              ? 'priority'
              : field === 'assignee'
                ? 'assignedTo'
                : field === 'sprint'
                  ? 'iterationPath'
                  : field;
        out.push({
          field: domainField,
          from: item.fromString ?? null,
          to: item.toString ?? null,
          at: h.created ?? new Date(0).toISOString(),
          by: h.author?.displayName ?? null,
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
    return {
      items,
      notes: ['Releases taken from the project profile. Jira fixVersions can replace this once release dates are reliable.'],
      unavailableFields: [],
    };
  }

  async fetchSprints(profile: ProjectProfile, _period: Period): Promise<CollectResult<Sprint>> {
    return {
      items: profile.sprints.map((s) => ({
        name: s.name,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        releaseId: null,
      })),
      notes: ['Sprints from profile. Jira Agile board API can supply these if the board id is configured.'],
      unavailableFields: [],
    };
  }
}
