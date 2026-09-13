import type { ImportanceScale, ProjectProfile } from '../../domain/profile.js';
import type { FieldChange, Iso, RawDefect, Release, Sprint } from '../../domain/types.js';

export type Env = 'prod' | 'pre-release' | 'unknown';
export type ImpLevel = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface NormalizedDefect {
  readonly raw: RawDefect;
  /** M2 */
  readonly env: Env;
  readonly envSource: string;
  readonly envVersion: string;
  /** Which independent markers fired - used to measure convention adherence. */
  readonly envMarkers: { readonly tag: boolean; readonly titlePrefix: boolean };
  /** Imp (D7) */
  readonly imp: ImpLevel;
  readonly impSource: string;
  /** T_det (D7) */
  readonly tDet: Iso;
  readonly tDetSource: string;
  /** M1 */
  readonly cohort: string | null;
  readonly cohortSource: string;
  /** Module (A9 / D7) */
  readonly module: string | null;
  readonly moduleSource: string;
  /** Derived flags */
  readonly isReopened: boolean;
  readonly isRejected: boolean;
  readonly isDuplicate: boolean;
  readonly isNoRepro: boolean;
  readonly isClosed: boolean;
  readonly isResolved: boolean;
  readonly firstTriageAt: Iso | null;
  readonly fixDays: number | null;
  readonly ageDays: number;
}

const lower = (s: string): string => s.trim().toLowerCase();
const hasAny = (haystack: readonly string[], needles: readonly string[]): boolean =>
  haystack.some((h) => needles.some((n) => lower(h) === lower(n)));

function textOf(d: RawDefect): string {
  return `${d.title} ${d.description ?? ''} ${d.reproSteps ?? ''}`.toLowerCase();
}

/**
 * A genuine edit, as opposed to the values written when the work item was
 * created. The tracker's first revision lists every initial field value, so
 * "this field appears in the history" is true for every field on every item -
 * including ones nobody has ever touched. Only a change with a previous value
 * is evidence that a human made a decision.
 */
export function wasEdited(d: RawDefect, field: string): boolean {
  return d.history.some((h) => h.field === field && h.from !== null);
}

/**
 * Does the title START with a production marker?
 *
 * Only the first few tokens are considered. Titles here look like
 * "EO. Not possible to send an invite" - a product code first, then the
 * subject - so the marker may be the first or second token, never the tenth.
 */
export function titleHasProdPrefix(title: string, profile: ProjectProfile): boolean {
  const prefixes = profile.env.prodTitlePrefixes;
  if (prefixes.length === 0) return false;
  const take = profile.env.titlePrefixTokens ?? 2;
  const tokens = title
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '')
    .slice(0, take)
    .map(lower);
  return prefixes.some((p) => tokens.includes(lower(p)));
}

/** M2. Detection environment, first matching version wins, versions OR-able. */
export function resolveEnv(
  d: RawDefect,
  profile: ProjectProfile,
): { env: Env; source: string; version: string; markers: { tag: boolean; titlePrefix: boolean } } {
  const rules = profile.env;
  const wanted = profile.versions.env;
  const order: readonly string[] = ['v1', 'v2', 'v3', 'v4'];
  const allowed = order.slice(0, order.indexOf(wanted) + 1);

  const tag = hasAny(d.tags, rules.prodTags);
  const titlePrefix = titleHasProdPrefix(d.title, profile);
  const markers = { tag, titlePrefix };

  if (allowed.includes('v1') && d.environmentField !== null) {
    const isProd = rules.prodFieldValues.some((v) => lower(v) === lower(d.environmentField ?? ''));
    return { env: isProd ? 'prod' : 'pre-release', source: `field:${d.environmentField}`, version: 'v1', markers };
  }
  // v2: deliberate human markers. Either one is sufficient; both are recorded
  // so the report can show how consistently the convention is followed.
  if (allowed.includes('v2') && (tag || titlePrefix)) {
    const source = tag && titlePrefix ? 'tag+title-prefix' : tag ? 'tag-only' : 'title-prefix-only';
    return { env: 'prod', source, version: 'v2', markers };
  }
  if (allowed.includes('v3') && d.createdBy !== null && hasAny([d.createdBy], rules.prodCreators)) {
    return { env: 'prod', source: 'creator', version: 'v3', markers };
  }
  if (allowed.includes('v4') && rules.prodKeywords.length > 0) {
    const text = textOf(d);
    const hit = rules.prodKeywords.find((k) => text.includes(lower(k)));
    if (hit !== undefined) return { env: 'prod', source: `keyword:${hit}`, version: 'v4', markers };
  }
  if (rules.closedWorld) {
    return { env: 'pre-release', source: 'closed-world-assumption', version: wanted, markers };
  }
  return { env: 'unknown', source: 'no-signal', version: wanted, markers };
}

const byDate = (a: FieldChange, b: FieldChange): number => Date.parse(a.at) - Date.parse(b.at);

function priorityAtFirstTriage(d: RawDefect): string | null {
  const changes = d.history.filter((h) => h.field === 'priority' && h.from !== null).sort(byDate);
  const first = changes[0];
  if (first !== undefined) return first.to;
  return d.priority;
}

/**
 * Was Severity actually set by a human, or is this the value the tracker wrote?
 *
 * A field that is 100% filled because of a default carries no information, and
 * treating it as data is how a metric becomes confidently wrong: every defect
 * lands on one importance level, every downstream cut by importance collapses,
 * and the report still says "computed".
 */
function severityWasSet(d: RawDefect, scale: ImportanceScale | undefined): boolean {
  if (d.severity === null || d.severity.trim() === '') return false;
  const fallback = scale?.defaultValue ?? null;
  if (fallback !== null && lower(d.severity) === lower(fallback)) {
    // Sitting on the default is only meaningful if someone actively put it back.
    return wasEdited(d, 'severity');
  }
  return true;
}

/**
 * Imp - which field expresses "how much this defect matters".
 *
 *   v1 Severity (default)          - technical impact, the ISTQB reading
 *   v2 Priority at first triage    - the decision the team made when it saw it
 *   v3 Priority now                - the current decision, revised after the fix
 *   v4 Severity if touched, else Priority at triage - migration period
 *
 * v2 is preferred over v3 where Priority is routinely lowered after a fix:
 * reading the current value would rewrite history in the project's favour.
 */
export function resolveImp(
  d: RawDefect,
  profile: ProjectProfile,
): { imp: ImpLevel; source: string } {
  const v = profile.versions.imp;
  const sevScale = profile.importance.severity;

  if (v === 'v2') {
    return { imp: classifyImp(priorityAtFirstTriage(d), profile.importance), source: 'priority@triage' };
  }
  if (v === 'v3') {
    return { imp: classifyImp(d.priority, profile.importance), source: 'priority@now' };
  }
  if (v === 'v4') {
    if (severityWasSet(d, sevScale)) {
      return { imp: classifyImp(d.severity, sevScale ?? profile.importance), source: 'severity(set)' };
    }
    return { imp: classifyImp(priorityAtFirstTriage(d), profile.importance), source: 'priority@triage(severity untouched)' };
  }
  return { imp: classifyImp(d.severity, sevScale ?? profile.importance), source: 'severity' };
}

export function classifyImp(value: string | null, scale: ImportanceScale): ImpLevel {
  if (value === null || value.trim() === '') return 'unknown';
  const v = lower(value);
  if (scale.criticalValues.some((x) => lower(x) === v)) return 'critical';
  if (scale.highValues.some((x) => lower(x) === v)) return 'high';
  if (scale.mediumValues.some((x) => lower(x) === v)) return 'medium';
  if (scale.lowValues.some((x) => lower(x) === v)) return 'low';
  return 'unknown';
}

/** T_det. v1 earliest linked observation, v2 created date. */
export function resolveTDet(d: RawDefect, profile: ProjectProfile): { tDet: Iso; source: string } {
  if (profile.versions.tDet === 'v1') {
    const observed = d.history
      .filter((h) => h.field === 'observedAt' && h.to !== null)
      .map((h) => h.to as string)
      .sort();
    const earliest = observed[0];
    if (earliest !== undefined) return { tDet: earliest, source: 'linked-observation' };
  }
  return { tDet: d.createdAt, source: 'createdAt' };
}

export function cohortOf(version: string): { cohort: string; isPatch: boolean } {
  const parts = version.trim().split('.');
  const major = parts[0] ?? '0';
  const minor = parts[1] ?? '0';
  const patch = Number.parseInt(parts[2] ?? '0', 10);
  return { cohort: `${major}.${minor}`, isPatch: Number.isFinite(patch) && patch > 0 };
}

/** A version string looks like 1.46.3, not like "Sprint 227". */
const looksLikeVersion = (v: string | null): boolean => v !== null && /^\d+(\.\d+)+/.test(v.trim());

/** Matches "Sprint 227" against "ECOHZOnline\ECOHZONE\Sprint 227" and vice versa. */
function findSprintByName(name: string, sprints: readonly Sprint[]): Sprint | undefined {
  const needle = lower(name);
  const tail = (s: string): string => lower(s.split('\\').pop() ?? s);
  return sprints.find((s) => lower(s.name) === needle || tail(s.name) === needle || tail(s.name) === tail(name));
}

/**
 * M1. Cohort attribution. Two different rules - this is the classic trap:
 *   field defect  -> the release live in production at T_det
 *   pre-release   -> the release whose development / stabilisation cycle found it
 *
 * A version is only accepted when the profile declares a release in that
 * cohort. Version fields accumulate typos, abandoned branches and one-off
 * values; without a known release date such a cohort has no observation window,
 * so counting it would silently corrupt DDP rather than add coverage. Declaring
 * the release is the way to include a version - not a list of exclusions.
 */
export function resolveCohort(
  d: RawDefect,
  env: Env,
  tDet: Iso,
  profile: ProjectProfile,
  releases: readonly Release[],
  sprints: readonly Sprint[],
): { cohort: string | null; source: string } {
  const t = Date.parse(tDet);
  const sorted = [...releases].sort((a, b) => Date.parse(a.releasedAt) - Date.parse(b.releasedAt));
  const known = new Set(sorted.map((r) => r.cohort));
  const nextReleaseAfter = (at: number): Release | undefined =>
    sorted.find((r) => Date.parse(r.releasedAt) > at);
  const accept = (raw: string, source: string): { cohort: string | null; source: string } => {
    const { cohort } = cohortOf(raw);
    return known.has(cohort)
      ? { cohort, source }
      : { cohort: null, source: `version-not-in-release-list:${cohort}` };
  };

  if (env === 'prod') {
    let live: Release | null = null;
    for (const r of sorted) {
      if (Date.parse(r.releasedAt) <= t) live = r;
    }
    return live === null
      ? { cohort: null, source: 'no-release-live-at-tdet' }
      : { cohort: live.cohort, source: 'release-live-at-tdet' };
  }

  const v = profile.versions.cohort;
  if (v === 'v1') {
    // The detection field may hold a real version, or a sprint name. Both are
    // usable; a sprint just needs one more hop to reach the release it fed.
    if (looksLikeVersion(d.versionDetected)) {
      return accept(d.versionDetected as string, 'versionDetected');
    }
    if (d.versionDetected !== null) {
      const sprint = findSprintByName(d.versionDetected, sprints);
      if (sprint !== undefined) {
        const mapped = sprint.releaseId === null ? undefined : sorted.find((r) => r.id === sprint.releaseId);
        if (mapped !== undefined) return { cohort: mapped.cohort, source: 'sprint-map(explicit)' };
        const after = nextReleaseAfter(Date.parse(sprint.endsAt));
        if (after !== undefined) return { cohort: after.cohort, source: 'sprint-map(next-release)' };
      }
    }
    const containing = sprints.find((s) => Date.parse(s.startsAt) <= t && t <= Date.parse(s.endsAt));
    if (containing !== undefined) {
      const after = nextReleaseAfter(Date.parse(containing.endsAt));
      if (after !== undefined) return { cohort: after.cohort, source: 'detection-sprint(next-release)' };
    }
  }
  if (v === 'v3' && looksLikeVersion(d.versionCorrected)) {
    return accept(d.versionCorrected as string, 'versionCorrected');
  }
  // v2 fallback: the release in development at T_det = next release shipped after T_det.
  const next = nextReleaseAfter(t);
  return next === undefined
    ? { cohort: null, source: 'no-release-in-development' }
    : { cohort: next.cohort, source: 'next-release-after-tdet' };
}

/**
 * Module. The chosen version names a preferred field, but every version falls
 * back, and which field actually carried the value is reported - a clustering
 * conclusion drawn on an area path means something different from one drawn on
 * a component.
 */
export function resolveModule(d: RawDefect, profile: ProjectProfile): { module: string | null; source: string } {
  const byComponent = (): { module: string | null; source: string } | null =>
    d.component === null ? null : { module: d.component, source: 'component' };
  const byArea = (): { module: string | null; source: string } | null =>
    d.areaPath === null ? null : { module: d.areaPath, source: 'areaPath' };
  const byOwner = (): { module: string | null; source: string } | null =>
    d.assignedTo === null ? null : { module: d.assignedTo, source: 'assignedTo' };

  const chain =
    profile.versions.module === 'v3' ? [byOwner, byComponent, byArea] : [byComponent, byArea, byOwner];
  for (const attempt of chain) {
    const result = attempt();
    if (result !== null) return result;
  }
  return { module: null, source: 'none' };
}

const RESOLVED_CATEGORIES: readonly string[] = ['resolved', 'closed'];

function detectReopen(d: RawDefect): boolean {
  const states = d.history.filter((h) => h.field === 'stateCategory').sort(byDate);
  let wasResolved = false;
  for (const s of states) {
    if (s.to !== null && RESOLVED_CATEGORIES.includes(s.to)) wasResolved = true;
    else if (wasResolved && s.to !== null && (s.to === 'active' || s.to === 'new')) return true;
  }
  return false;
}

function firstTriage(d: RawDefect): Iso | null {
  const meaningful = d.history
    .filter(
      (h) =>
        (h.field === 'assignedTo' || h.field === 'priority' || h.field === 'stateCategory') &&
        h.from !== null,
    )
    .sort(byDate);
  return meaningful[0]?.at ?? d.activatedAt;
}

const DAY = 86_400_000;

export function normalize(
  defects: readonly RawDefect[],
  releases: readonly Release[],
  sprints: readonly Sprint[],
  profile: ProjectProfile,
  now: Date = new Date(),
): readonly NormalizedDefect[] {
  const res = profile.resolution;
  return defects.map((d) => {
    const envRes = resolveEnv(d, profile);
    const impRes = resolveImp(d, profile);
    const tDetRes = resolveTDet(d, profile);
    const cohortRes = resolveCohort(d, envRes.env, tDetRes.tDet, profile, releases, sprints);
    const moduleRes = resolveModule(d, profile);
    const resolution = d.resolution === null ? '' : lower(d.resolution);
    const endAt = d.resolvedAt ?? d.closedAt;
    return {
      raw: d,
      env: envRes.env,
      envSource: envRes.source,
      envVersion: envRes.version,
      envMarkers: envRes.markers,
      imp: impRes.imp,
      impSource: impRes.source,
      tDet: tDetRes.tDet,
      tDetSource: tDetRes.source,
      cohort: cohortRes.cohort,
      cohortSource: cohortRes.source,
      module: moduleRes.module,
      moduleSource: moduleRes.source,
      isReopened: detectReopen(d),
      isRejected: res.rejected.some((x) => lower(x) === resolution),
      isDuplicate: res.duplicate.some((x) => lower(x) === resolution),
      isNoRepro: res.noRepro.some((x) => lower(x) === resolution),
      isClosed: d.stateCategory === 'closed',
      isResolved: d.stateCategory === 'resolved' || d.stateCategory === 'closed',
      firstTriageAt: firstTriage(d),
      fixDays: endAt === null ? null : (Date.parse(endAt) - Date.parse(tDetRes.tDet)) / DAY,
      ageDays: ((endAt === null ? now.getTime() : Date.parse(endAt)) - Date.parse(tDetRes.tDet)) / DAY,
    };
  });
}

/**
 * Agreement between the two independent production markers.
 *
 * This is cheap validation of the closed-world assumption. If the tag and the
 * title prefix disagree often, neither is a reliable Env signal, and DDP - which
 * is entirely built on Env - carries that error into the leads sync.
 */
export interface EnvMarkerAgreement {
  readonly both: number;
  readonly tagOnly: number;
  readonly titleOnly: number;
  readonly neither: number;
  readonly markedTotal: number;
  readonly disagreementRate: number;
  readonly warnings: readonly string[];
}

export function envMarkerAgreement(
  defects: readonly NormalizedDefect[],
  profile: ProjectProfile,
): EnvMarkerAgreement {
  let both = 0;
  let tagOnly = 0;
  let titleOnly = 0;
  for (const d of defects) {
    const { tag, titlePrefix } = d.envMarkers;
    if (tag && titlePrefix) both += 1;
    else if (tag) tagOnly += 1;
    else if (titlePrefix) titleOnly += 1;
  }
  const markedTotal = both + tagOnly + titleOnly;
  const disagreement = markedTotal === 0 ? 0 : (tagOnly + titleOnly) / markedTotal;
  const max = profile.thresholds.envMarkerDisagreementMax ?? 0.2;
  const warnings: string[] = [];

  if (markedTotal === 0) {
    warnings.push(
      'No defect carries either production marker. Env rests entirely on the closed-world assumption, so DDP is an upper bound, not a measurement.',
    );
  } else if (disagreement > max) {
    warnings.push(
      `The two production markers disagree on ${(disagreement * 100).toFixed(0)}% of marked defects (${tagOnly} tag-only, ${titleOnly} title-only). The convention is not applied consistently, so the true production count is at least ${markedTotal} and possibly higher - DDP is correspondingly optimistic.`,
    );
  }
  if (titleOnly > 0 && tagOnly === 0) {
    warnings.push(
      `${titleOnly} defect(s) are marked by title only and never tagged. The tag is the machine-readable signal; consider making it the convention and the title prefix a convenience.`,
    );
  }
  return {
    both,
    tagOnly,
    titleOnly,
    neither: defects.length - markedTotal,
    markedTotal,
    disagreementRate: disagreement,
    warnings,
  };
}

export interface ScopeResult {
  readonly included: readonly RawDefect[];
  readonly totalBefore: number;
  readonly excludedByRule: Readonly<Record<string, number>>;
  /** Rubin (1976): if the excluded part differs systematically, the kept part is biased. */
  readonly biasWarnings: readonly string[];
  readonly description: string;
}

function fieldValue(d: RawDefect, field: string): string | null {
  const record = d as unknown as Record<string, unknown>;
  const v = record[field];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length === 0 ? null : v.join(',');
  const s = String(v).trim();
  return s === '' ? null : s;
}

function distribution(defects: readonly RawDefect[], key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of defects) {
    const v = fieldValue(d, key) ?? '(empty)';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/**
 * Applies the analysis scope. Runs at analysis time, not collection time, so
 * the scope can be changed and the report regenerated on the same snapshot.
 */
export function applyScope(defects: readonly RawDefect[], profile: ProjectProfile): ScopeResult {
  const scope = profile.scope;
  if (scope === undefined) {
    return {
      included: defects,
      totalBefore: defects.length,
      excludedByRule: {},
      biasWarnings: [],
      description: 'no scope filter - every collected defect is analysed',
    };
  }

  const iteration = scope.iterationPathPattern === undefined ? null : new RegExp(scope.iterationPathPattern);
  const area = scope.areaPathPattern === undefined ? null : new RegExp(scope.areaPathPattern);
  const required = scope.requireFields ?? [];

  const excludedByRule: Record<string, number> = {};
  const bump = (rule: string): void => {
    excludedByRule[rule] = (excludedByRule[rule] ?? 0) + 1;
  };

  const included: RawDefect[] = [];
  const excluded: RawDefect[] = [];
  for (const d of defects) {
    let reason: string | null = null;
    if (iteration !== null && !iteration.test(d.iterationPath ?? '')) reason = 'iterationPathPattern';
    else if (area !== null && !area.test(d.areaPath ?? '')) reason = 'areaPathPattern';
    else {
      const missing = required.find((f) => fieldValue(d, f) === null);
      if (missing !== undefined) reason = `requireFields:${missing}`;
    }
    if (reason === null) included.push(d);
    else {
      excluded.push(d);
      bump(reason);
    }
  }

  const biasWarnings: string[] = [];
  if (excluded.length >= 20 && included.length >= 20) {
    for (const key of ['priority', 'stateCategory', 'createdBy']) {
      const inc = distribution(included, key);
      const exc = distribution(excluded, key);
      for (const [value, n] of exc) {
        const excShare = n / excluded.length;
        const incShare = (inc.get(value) ?? 0) / included.length;
        if (excShare > 0.25 && excShare - incShare > 0.2) {
          biasWarnings.push(
            `Excluded defects are ${(excShare * 100).toFixed(0)}% "${key}=${value}" against ${(incShare * 100).toFixed(0)}% in scope. The filter is not neutral: conclusions describe the filtered population, not the project.`,
          );
        }
      }
    }
  }

  const parts: string[] = [];
  if (scope.iterationPathPattern !== undefined) parts.push(`iterationPath ~ /${scope.iterationPathPattern}/`);
  if (scope.areaPathPattern !== undefined) parts.push(`areaPath ~ /${scope.areaPathPattern}/`);
  if (required.length > 0) parts.push(`non-empty: ${required.join(', ')}`);

  return {
    included,
    totalBefore: defects.length,
    excludedByRule,
    biasWarnings,
    description: parts.join(' AND ') || 'no scope filter',
  };
}