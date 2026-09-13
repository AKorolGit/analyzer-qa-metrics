import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectProfile } from '../domain/profile.js';
import type { CiPort, TrackerPort, VcsPort } from '../ports/index.js';
import type { RawDefect } from '../domain/types.js';
import { FileSnapshotStore } from '../adapters/store/fs-store.js';
import { FixtureTracker } from '../adapters/tracker/fixture.js';
import { AzureDevOpsTracker, type FieldOverrides } from '../adapters/tracker/azure-devops.js';
import { JiraTracker } from '../adapters/tracker/jira.js';
import { GitHubVcs } from '../adapters/vcs/github.js';
import { LocalGitVcs } from '../adapters/vcs/local-git.js';
import { FixtureCi, NullCi } from '../adapters/ci/fixture.js';
import { AzurePipelinesCi, CompositeCi } from '../adapters/ci/azure-pipelines.js';
import { JsonFileCi } from '../adapters/ci/json-file.js';
import { collectionUrl, projectUrl } from '../adapters/tracker/ado-url.js';
import { cohortOf } from '../core/normalize/index.js';
import { analyse, collect, loadInputs, report } from '../core/pipeline.js';

const COMMANDS = [
  'check',
  'fields',
  'collect',
  'analyze',
  'report',
  'run',
  'runs',
  'doctor',
  'scope',
  'releases',
] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  readonly command: string;
  readonly profilePath: string;
  readonly runId: string | null;
  readonly out: string;
  readonly offline: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const idx = argv.indexOf(`--${name}`);
    return idx === -1 ? null : (argv[idx + 1] ?? null);
  };
  return {
    command: argv[2] ?? 'run',
    profilePath: get('profile') ?? 'config/profile.json',
    runId: get('run'),
    out: get('out') ?? 'data',
    offline: argv.includes('--offline'),
  };
}

async function loadProfile(path: string): Promise<ProjectProfile> {
  const full = resolve(path);
  if (!existsSync(full)) {
    throw new Error(
      `Profile not found: ${full}\nStart from a template:  cp config/profile.example.json config/profile.json`,
    );
  }
  let profile: ProjectProfile;
  try {
    profile = JSON.parse(await readFile(full, 'utf8')) as ProjectProfile;
  } catch (error) {
    throw new Error(`Profile ${full} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
  }
  if (profile.name === undefined || profile.period === undefined) {
    throw new Error(`Profile ${path} is missing required keys (name, period).`);
  }
  return profile;
}

function fieldOverrides(profile: ProjectProfile): FieldOverrides {
  return (profile.tracker.fieldOverrides ?? {}) as FieldOverrides;
}

function buildTracker(profile: ProjectProfile): TrackerPort {
  switch (profile.tracker.kind) {
    case 'azure-devops': {
      const pat = process.env['ADO_PAT'];
      if (pat === undefined || pat === '') throw new Error('ADO_PAT is not set. Copy .env.example to .env and fill it in.');
      return new AzureDevOpsTracker(pat, fetch, fieldOverrides(profile));
    }
    case 'jira': {
      const email = process.env['JIRA_EMAIL'];
      const token = process.env['JIRA_API_TOKEN'];
      if (email === undefined || token === undefined) throw new Error('JIRA_EMAIL / JIRA_API_TOKEN are not set.');
      const raw = process.env['JIRA_FIELD_MAP'];
      const map = raw === undefined ? {} : (JSON.parse(raw) as Record<string, string>);
      return new JiraTracker(email, token, map);
    }
    default:
      return new FixtureTracker();
  }
}

function repoPath(profile: ProjectProfile): string | null {
  const path = profile.vcs.path ?? process.env['REPO_PATH'];
  return path === undefined || path === '' ? null : path;
}

function buildVcs(profile: ProjectProfile): VcsPort | null {
  if (profile.vcs.kind === 'local-git') {
    const path = repoPath(profile);
    if (path === null) {
      console.warn('vcs.path (or REPO_PATH) is not set; churn-dependent metrics will report as not computable.');
      return null;
    }
    return new LocalGitVcs(path);
  }
  if (profile.vcs.kind !== 'github') return null;
  const token = process.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    console.warn('GITHUB_TOKEN is not set; churn-dependent metrics will report as not computable.');
    return null;
  }
  return new GitHubVcs(token);
}

function buildCi(profile: ProjectProfile): CiPort {
  const kind = profile.ci?.kind ?? (profile.tracker.kind === 'fixture' ? 'fixture' : 'none');
  const runDir = profile.ci?.runSummaryDir ?? 'qa-runs';
  switch (kind) {
    case 'fixture':
      return new FixtureCi();
    case 'json-file':
      return new JsonFileCi(runDir);
    case 'azure-pipelines': {
      const pat = process.env['ADO_PAT'];
      if (pat === undefined || pat === '') throw new Error('ADO_PAT is required for the azure-pipelines CI source.');
      const ado = new AzurePipelinesCi(pat);
      // Deployments from ADO, test runs from the reporters: only the runner can
      // tell a TAS failure from a product failure, and Q16 depends on that.
      return profile.ci?.runSummaryDir === undefined ? ado : new CompositeCi(ado, new JsonFileCi(runDir));
    }
    default:
      return new NullCi();
  }
}

/* ------------------------------------------------------------------ check */

type CheckLevel = 'ok' | 'warn' | 'fail';
interface CheckRow {
  readonly level: CheckLevel;
  readonly what: string;
  readonly detail: string;
}

const MARK: Record<CheckLevel, string> = { ok: ' ok ', warn: 'warn', fail: 'FAIL' };

const IMP_DESCRIPTION: Record<string, string> = {
  v1: 'Severity (default) - technical impact',
  v2: 'Priority at first triage - the decision made when the team saw it',
  v3: 'Priority now - the current decision, may have been revised after the fix',
  v4: 'Severity if a human touched it, otherwise Priority at triage',
};

function checkStatic(profile: ProjectProfile, out: string): CheckRow[] {
  const rows: CheckRow[] = [];
  const add = (level: CheckLevel, what: string, detail: string): void => {
    rows.push({ level, what, detail });
  };

  const from = Date.parse(profile.period.from);
  const to = Date.parse(profile.period.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    add('fail', 'period', 'from/to are not valid ISO dates in ascending order');
  } else {
    const days = Math.round((to - from) / 86_400_000);
    add(days >= 90 ? 'ok' : 'warn', 'period', `${days} days${days < 90 ? ' - short; trends need several release cohorts' : ''}`);
  }

  if (profile.tracker.kind === 'azure-devops') {
    const url = projectUrl(profile.tracker.baseUrl, profile.tracker.organization, profile.tracker.project);
    add(profile.tracker.project === undefined ? 'fail' : 'ok', 'tracker endpoint', `${url}/_apis`);
    add(
      process.env['ADO_PAT'] === undefined || process.env['ADO_PAT'] === '' ? 'fail' : 'ok',
      'ADO_PAT',
      process.env['ADO_PAT'] ? 'set' : 'missing - needs Work Items: Read (+ Release: Read for DORA)',
    );
  }

  const overrides = profile.tracker.fieldOverrides ?? {};
  const overrideList = Object.entries(overrides).filter(([, v]) => v !== undefined && v !== '');
  add(
    overrideList.length === 0 ? 'warn' : 'ok',
    'field overrides',
    overrideList.length === 0
      ? 'none set - run `npm run fields` to see what this instance actually has'
      : overrideList.map(([k, v]) => `${k}=${String(v)}`).join(', '),
  );

  // Which field expresses importance is the most consequential single choice in
  // the profile: it decides what "critical defect" means everywhere downstream.
  add('ok', 'importance source', `${profile.versions.imp} - ${IMP_DESCRIPTION[profile.versions.imp] ?? 'unknown'}`);

  const scope = profile.scope;
  if (scope !== undefined) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value !== 'string') continue;
      try {
        void new RegExp(value);
        parts.push(`${key}=/${value}/`);
      } catch {
        add('fail', 'scope regex', `${key} is not a valid regular expression: ${value}`);
      }
    }
    if (scope.requireFields !== undefined && scope.requireFields.length > 0) {
      parts.push(`requireFields=${scope.requireFields.join(',')}`);
    }
    add('warn', 'scope filter', `${parts.join(' AND ')} - verify with \`npm run scope\`; a filter that matches nothing yields an empty report`);
  }

  if (profile.vcs.kind === 'local-git') {
    const path = repoPath(profile);
    if (path === null) add('warn', 'local git', 'vcs.path / REPO_PATH not set - churn metrics disabled');
    else if (!existsSync(resolve(path, '.git'))) add('fail', 'local git', `${resolve(path)} has no .git - not a repository root`);
    else add('ok', 'local git', `${resolve(path)}${profile.vcs.branch === undefined ? ' (all refs)' : ` on ${profile.vcs.branch}`}`);
  } else {
    add('warn', 'vcs', `${profile.vcs.kind} - Q14 density and code-risk metrics need commit history`);
  }

  const releases = profile.releases.length;
  add(
    releases === 0 ? 'fail' : releases < 4 ? 'warn' : 'ok',
    'releases',
    releases === 0
      ? 'none defined - DDP (Q9) and field defects (Q10) cannot be computed at all. Run `npm run releases` for a draft list'
      : `${releases} defined${releases < 4 ? ' - a process behaviour chart needs 4-6 mature cohorts; `npm run releases` proposes more' : ''}`,
  );

  const env = profile.env;
  const signals = [
    env.prodFieldValues.length > 0 ? 'field' : null,
    env.prodTags.length > 0 ? 'tags' : null,
    env.prodTitlePrefixes.length > 0 ? 'title prefix' : null,
    env.prodCreators.length > 0 ? 'creators' : null,
    env.prodKeywords.length > 0 ? 'keywords' : null,
  ].filter((s): s is string => s !== null);
  add(
    signals.length === 0 ? 'fail' : 'ok',
    'production markers',
    signals.length === 0 ? 'no way to identify a production defect - DDP would be fiction' : signals.join(' + '),
  );
  if (env.closedWorld) {
    add('warn', 'closed-world', '"no signal = not prod" is ON - DDP is an upper bound until the marker agreement table says otherwise');
  }

  if (profile.versions.imp === 'v1' || profile.versions.imp === 'v4') {
    add(
      profile.importance.severity === undefined ? 'warn' : 'ok',
      'severity scale',
      profile.importance.severity === undefined
        ? `Imp ${profile.versions.imp} reads Severity, but importance.severity is not defined - Priority values would be matched against Severity strings`
        : 'defined separately from priority',
    );
  }

  for (const [key, path] of Object.entries(profile.manualInputs ?? {})) {
    if (typeof path !== 'string') continue;
    const found = existsSync(resolve(path));
    add(found ? 'ok' : 'warn', `manual input: ${key}`, found ? path : `${path} not found - the metric will report NEEDS INPUT`);
  }

  add('ok', 'output directory', resolve(out));
  return rows;
}

async function probeAdo(profile: ProjectProfile): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const pat = process.env['ADO_PAT'];
  if (pat === undefined || pat === '') return rows;

  const collection = collectionUrl(profile.tracker.baseUrl, profile.tracker.organization);
  const url = `${collection}/_apis/projects?api-version=7.1&$top=500`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      rows.push({
        level: 'fail',
        what: 'collection reachable',
        detail:
          res.status === 401 || res.status === 403
            ? `${res.status} at ${collection} - either this collection URL is wrong (ADO answers 401, not 404, for a collection that does not exist) or the PAT lacks "Project and Team: Read". Open the URL in a browser: if it 404s, the URL is the problem.`
            : `${res.status} at ${collection} - ${body.slice(0, 160)}`,
      });
      return rows;
    }
    const body = (await res.json()) as { value?: { name: string }[] };
    const names = (body.value ?? []).map((p) => p.name);
    rows.push({ level: 'ok', what: 'collection reachable', detail: `${collection} - ${names.length} project(s)` });

    const wanted = (profile.tracker.project ?? '').trim();
    const exact = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
    if (exact !== undefined) {
      rows.push({
        level: exact === wanted ? 'ok' : 'warn',
        what: 'project exists',
        detail: exact === wanted ? exact : `matched "${exact}" - your profile says "${wanted}" (case differs)`,
      });
    } else {
      const near = names.filter((n) => n.toLowerCase().includes(wanted.toLowerCase().slice(0, 5)));
      rows.push({
        level: 'fail',
        what: 'project exists',
        detail: `"${wanted}" is not in this collection. ${
          near.length > 0 ? `Did you mean: ${near.join(', ')}?` : `Available: ${names.slice(0, 10).join(', ')}`
        }`,
      });
    }
  } catch (error) {
    rows.push({
      level: 'warn',
      what: 'collection reachable',
      detail: `could not reach ${collection}: ${error instanceof Error ? error.message : 'network error'}`,
    });
  }
  return rows;
}

function printChecks(rows: readonly CheckRow[]): boolean {
  const width = Math.max(...rows.map((r) => r.what.length));
  for (const r of rows) console.log(`[${MARK[r.level]}] ${r.what.padEnd(width)}  ${r.detail}`);
  const fails = rows.filter((r) => r.level === 'fail').length;
  const warns = rows.filter((r) => r.level === 'warn').length;
  console.log(`\n${fails} blocking, ${warns} warning(s).`);
  return fails === 0;
}

/* ----------------------------------------------------------------- fields */

async function discoverFields(profile: ProjectProfile): Promise<void> {
  if (profile.tracker.kind !== 'azure-devops') throw new Error('`fields` is implemented for Azure DevOps only.');
  const pat = process.env['ADO_PAT'];
  if (pat === undefined || pat === '') throw new Error('ADO_PAT is not set.');
  const tracker = new AzureDevOpsTracker(pat, fetch, fieldOverrides(profile));
  const rows = await tracker.discoverFields(profile, profile.period);
  const interesting = rows.filter(
    (r) => /custom|severity|environment|cause|found|repro|build|version/i.test(r.field) || r.filled >= 0.5,
  );
  console.log(`\n${rows.length} distinct fields on the sampled bugs. Showing ${interesting.length}:\n`);
  for (const r of interesting) {
    console.log(`${(r.filled * 100).toFixed(0).padStart(4)}%  ${r.field.padEnd(48)} ${r.sample ?? ''}`);
  }
  console.log(
    '\nPut the reference names into config/profile.json under tracker.fieldOverrides,\nthen run `npm run check` and `npm run collect`.',
  );
}

/* --------------------------------------------------------------- releases */

const isVersion = (v: string): boolean => /^v?\d+(\.\d+){1,3}$/.test(v.trim());

/**
 * Proposes a `releases` array from evidence rather than memory.
 *
 * Release dates cannot be collected from the tracker, but they are not a
 * guess either: git tags record when a version shipped, and the defects
 * themselves show which versions are real and how much traffic each carried.
 * Cross-referencing the two turns a tedious manual list into a review task.
 */
async function proposeReleases(
  profile: ProjectProfile,
  store: FileSnapshotStore,
  runIdArg: string | null,
): Promise<void> {
  const id = runIdArg ?? (await store.latestRunId());
  if (id === null) throw new Error('No snapshot found. Run `npm run collect` first.');
  const snapshot = await store.loadSnapshot(id);

  const seen = new Map<string, { count: number; first: string; last: string }>();
  for (const d of snapshot.defects) {
    const raw = d.versionCorrected ?? d.versionDetected;
    if (raw === null || !isVersion(raw)) continue;
    const version = raw.trim().replace(/^v/i, '');
    const cur = seen.get(version) ?? { count: 0, first: d.createdAt, last: d.createdAt };
    cur.count += 1;
    if (d.createdAt < cur.first) cur.first = d.createdAt;
    if (d.createdAt > cur.last) cur.last = d.createdAt;
    seen.set(version, cur);
  }

  const path = repoPath(profile);
  const tags = path === null ? [] : await new LocalGitVcs(path).fetchTags();
  const tagByVersion = new Map<string, string>();
  for (const t of tags) {
    const cleaned = t.name.replace(/^v/i, '').trim();
    if (isVersion(cleaned)) tagByVersion.set(cleaned, t.date);
  }

  const declared = new Set(profile.releases.map((r) => r.version));
  const rows = [...seen.entries()]
    .map(([version, info]) => {
      const tagDate = tagByVersion.get(version) ?? null;
      return {
        version,
        cohort: cohortOf(version).cohort,
        defects: info.count,
        tagDate,
        // Without a tag, the last defect attributed to a version is the closest
        // available proxy for when it shipped. It is a proxy, not a fact.
        proposedDate: tagDate ?? info.last,
        source: tagDate === null ? 'PROXY: last defect on this version' : 'git tag',
        declared: declared.has(version),
      };
    })
    .sort((a, b) => a.proposedDate.localeCompare(b.proposedDate));

  console.log(`\nRun ${id} - ${tags.length} git tag(s), ${rows.length} version(s) seen on defects\n`);
  if (rows.length === 0) {
    console.log('No version-shaped values on any defect. Check tracker.fieldOverrides.versionCorrected.');
    return;
  }

  const width = Math.max(...rows.map((r) => r.version.length), 7);
  console.log(`${'version'.padEnd(width)}  cohort  defects  date         source`);
  for (const r of rows) {
    console.log(
      `${r.version.padEnd(width)}  ${r.cohort.padEnd(6)}  ${String(r.defects).padStart(7)}  ${r.proposedDate.slice(0, 10)}  ${r.source}${r.declared ? '  [already in profile]' : ''}`,
    );
  }

  // Only one release per cohort matters: DDP counts defects against the cohort,
  // and listing every patch would split one observation window into several.
  const byCohort = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const existing = byCohort.get(r.cohort);
    if (existing === undefined || r.proposedDate < existing.proposedDate) byCohort.set(r.cohort, r);
  }
  const proposal = [...byCohort.values()]
    .sort((a, b) => a.proposedDate.localeCompare(b.proposedDate))
    .map((r) => ({ version: r.version, releasedAt: new Date(r.proposedDate).toISOString() }));

  console.log(`\nDraft "releases" for config/profile.json (${proposal.length} cohorts):\n`);
  console.log(JSON.stringify(proposal, null, 2));
  console.log(
    '\nReview before pasting. The earliest version in each cohort is used, because a\ncohort is one observation window; patch releases belong inside it, not beside it.\nRows marked PROXY are inferred from defect activity - correct them from your\nrelease notes where you can, since DDP@W depends on the date being right.',
  );
}

/* ------------------------------------------------------------------ scope */

function raw(d: RawDefect, field: string): string | null {
  const record = d as unknown as Record<string, unknown>;
  const v = record[field];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length === 0 ? null : v.join(',');
  const s = String(v).trim();
  return s === '' ? null : s;
}

function topValues(defects: readonly RawDefect[], field: string, limit: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const d of defects) {
    const v = raw(d, field) ?? '(empty)';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function showScope(profile: ProjectProfile, store: FileSnapshotStore, runIdArg: string | null): Promise<void> {
  const id = runIdArg ?? (await store.latestRunId());
  if (id === null) throw new Error('No snapshot found. Run `npm run collect` first.');
  const snapshot = await store.loadSnapshot(id);
  const defects = snapshot.defects;
  const scope = profile.scope;

  console.log(`\nRun ${id} - ${defects.length} defects collected\n`);
  if (scope === undefined) {
    console.log('No scope filter configured; every collected defect is analysed.');
    return;
  }

  // Each rule tested on its own, against the full population. Sequential
  // filtering hides which rule is responsible when the first one matches nothing.
  const rules: { label: string; matches: (d: RawDefect) => boolean }[] = [];
  if (scope.iterationPathPattern !== undefined) {
    const re = new RegExp(scope.iterationPathPattern);
    rules.push({ label: `iterationPath ~ /${scope.iterationPathPattern}/`, matches: (d) => re.test(d.iterationPath ?? '') });
  }
  if (scope.areaPathPattern !== undefined) {
    const re = new RegExp(scope.areaPathPattern);
    rules.push({ label: `areaPath ~ /${scope.areaPathPattern}/`, matches: (d) => re.test(d.areaPath ?? '') });
  }
  for (const field of scope.requireFields ?? []) {
    rules.push({ label: `${field} is non-empty`, matches: (d) => raw(d, field) !== null });
  }

  console.log('Each rule tested independently against all collected defects:\n');
  for (const rule of rules) {
    const n = defects.filter(rule.matches).length;
    console.log(`  ${String(n).padStart(5)}/${defects.length}  ${rule.label}${n === 0 ? ' <-- matches nothing' : ''}`);
  }
  const all = defects.filter((d) => rules.every((r) => r.matches(d))).length;
  console.log(`\n  ${String(all).padStart(5)}/${defects.length}  ALL rules combined\n`);

  const fieldsToShow = new Set<string>();
  if (scope.iterationPathPattern !== undefined) fieldsToShow.add('iterationPath');
  if (scope.areaPathPattern !== undefined) fieldsToShow.add('areaPath');
  for (const f of scope.requireFields ?? []) fieldsToShow.add(f);

  for (const field of fieldsToShow) {
    console.log(`Actual values of ${field} (top 12):`);
    for (const [value, n] of topValues(defects, field, 12)) {
      console.log(`  ${String(n).padStart(5)}  ${value}`);
    }
    console.log('');
  }
  console.log(
    'In JSON a backslash is escaped twice: "\\\\\\\\Sprint" in the file becomes the\nregex \\\\Sprint, which matches one literal backslash.',
  );
}

/* ----------------------------------------------------------------- doctor */

async function doctor(profile: ProjectProfile, store: FileSnapshotStore, runIdArg: string | null): Promise<void> {
  const id = runIdArg ?? (await store.latestRunId());
  if (id === null) throw new Error('No snapshot found. Run `npm run collect` first.');
  const snapshot = await store.loadSnapshot(id);
  const analysis = analyse(snapshot, profile, new Date(), await loadInputs(profile));
  const inScope = analysis.scope.included.length;

  console.log(`\nRun ${id}\n`);
  console.log(`Collected ${analysis.scope.totalBefore} defects, ${inScope} in scope.`);
  console.log(`Scope: ${analysis.scope.description}\n`);

  const excluded = Object.entries(analysis.scope.excludedByRule);
  if (excluded.length > 0) {
    console.log('Excluded by');
    for (const [rule, n] of excluded.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${rule}`);
    }
    console.log('  (rules are evaluated in order; a defect is counted against the first rule it fails)\n');
  }

  if (inScope === 0) {
    console.log('THE SCOPE FILTER MATCHED NOTHING.');
    console.log('Every metric below would report on an empty set, so the run stops here.');
    console.log('Run `npm run scope` to see which rule is at fault and what the real values look like.\n');
    return;
  }

  const pct = (n: number): string => `${((n / Math.max(1, inScope)) * 100).toFixed(0)}%`;
  const show = (title: string, sources: Readonly<Record<string, number>>): void => {
    console.log(title);
    for (const [source, n] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pct(n).padStart(4)}  ${String(n).padStart(5)}  ${source}`);
    }
    console.log('');
  };
  show('Env resolved from', analysis.envSources);
  show(`Imp resolved from (versions.imp = ${profile.versions.imp})`, analysis.impSources);
  show('Cohort resolved from', analysis.cohortSources);

  const configErrors = snapshot.sourceNotes.filter((n) => n.startsWith('CONFIG ERROR'));
  if (configErrors.length > 0) {
    console.log('CONFIG ERRORS');
    for (const e of configErrors) console.log(`  ! ${e}`);
    console.log('');
  }

  const a = analysis.envAgreement;
  console.log('Production markers');
  console.log(`  both agree ${a.both} · tag only ${a.tagOnly} · title only ${a.titleOnly} · unmarked ${a.neither}`);
  console.log(`  disagreement ${(a.disagreementRate * 100).toFixed(0)}%`);
  for (const w of a.warnings) console.log(`  ! ${w}`);
  console.log('');

  console.log('Data fitness (worst first)');
  for (const f of [...analysis.fitness.fields].sort((x, y) => x.completeness - y.completeness).slice(0, 8)) {
    console.log(
      `  ${(f.completeness * 100).toFixed(0).padStart(4)}%  ${f.field.padEnd(18)} ${f.verdict.padEnd(9)} ${f.reasons.join('; ')}`,
    );
  }
  console.log('');

  const blocked = analysis.metrics.filter((m) => m.status === 'not-computable');
  if (blocked.length > 0) {
    console.log('Blocked metrics');
    for (const m of blocked) console.log(`  ${m.id.padEnd(6)} ${m.caveats[0] ?? ''}`);
    console.log('');
  }
  console.log('Fix the items above, then `npm run report`.');
}

/* ------------------------------------------------------------------- runs */

async function listRuns(out: string): Promise<void> {
  const path = resolve(out, 'runs.jsonl');
  if (!existsSync(path)) {
    console.log('No reports generated yet.');
    return;
  }
  const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  for (const line of lines.slice(-15)) {
    const e = JSON.parse(line) as Record<string, unknown>;
    console.log(
      `${String(e['generatedAt']).slice(0, 16)}  ${String(e['runId']).padEnd(38)} ` +
        `scope ${String(e['defectsInScope'] ?? '?').padStart(5)}/${String(e['defectsCollected'] ?? '?').padEnd(5)} ` +
        `Q1 ${((Number(e['q1'] ?? 0)) * 100).toFixed(0).padStart(3)}%  ` +
        `findings ${String(e['findings'] ?? 0)} (${String(e['criticalFindings'] ?? 0)} critical)`,
    );
  }
  console.log(`\n${lines.length} report(s) total. Each one is a separate file; nothing is ever overwritten.`);
}

/* ------------------------------------------------------------------- main */

function usage(): void {
  console.log(`
qa-metrics-analyzer

  Setup, once
    npm run check       validate the profile, then verify the collection and
                        project actually exist (add --offline to skip the call)
    npm run fields      list the fields this ADO project actually has

  Every measurement cycle
    npm run collect     pull from tracker + git + CI, write an immutable snapshot
    npm run releases    propose a releases list from git tags and defect data
    npm run scope       what the scope filter matches, rule by rule
    npm run doctor      diagnose the snapshot: what resolved, what fell back
    npm run report      render the report - a NEW file every time, cheap to repeat

  Shortcuts
    npm run full        check + collect + report
    npm run analyze     summary to stdout, writes nothing
    npm run runs        history of generated reports
    npm run demo        synthetic data, no credentials needed

  Flags
    --profile <path>    default config/profile.json
    --run <runId>       operate on a specific snapshot instead of the latest
    --out <dir>         default data/
    --offline           check without contacting the tracker

  Collect hits the API and costs time; everything else runs on the stored
  snapshot. Tune the filter, thresholds and formula versions and re-run report
  as often as needed.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.command === 'help' || args.command === '--help') {
    usage();
    return;
  }
  if (!(COMMANDS as readonly string[]).includes(args.command)) {
    console.error(`Unknown command "${args.command}".`);
    usage();
    process.exitCode = 1;
    return;
  }
  const command = args.command as Command;
  const profile = await loadProfile(args.profilePath);
  const store = new FileSnapshotStore(args.out);
  const now = new Date();

  if (command === 'check') {
    const rows = checkStatic(profile, args.out);
    if (!args.offline && profile.tracker.kind === 'azure-devops') {
      rows.push(...(await probeAdo(profile)));
    }
    const ok = printChecks(rows);
    if (!ok) {
      console.log('Blocking problems above will make the report empty or wrong. Fix them before collecting.');
      process.exitCode = 1;
    } else {
      console.log('Ready. Next: npm run collect');
    }
    return;
  }
  if (command === 'fields') {
    await discoverFields(profile);
    return;
  }
  if (command === 'releases') {
    await proposeReleases(profile, store, args.runId);
    return;
  }
  if (command === 'scope') {
    await showScope(profile, store, args.runId);
    return;
  }
  if (command === 'runs') {
    await listRuns(args.out);
    return;
  }
  if (command === 'doctor') {
    await doctor(profile, store, args.runId);
    return;
  }

  if (command === 'collect' || command === 'run') {
    const snapshot = await collect(profile, buildTracker(profile), buildVcs(profile), buildCi(profile), store, now);
    console.log(`Snapshot saved: run ${snapshot.runId} (${snapshot.defects.length} defects)`);
    for (const note of snapshot.sourceNotes) console.log(`  · ${note}`);
    if (command === 'collect') {
      console.log('\nNext: npm run doctor   (check the data)   then   npm run report');
      return;
    }
    const analysis = analyse(snapshot, profile, now, await loadInputs(profile));
    const paths = await report(analysis, profile, store, now);
    printSummary(analysis, paths);
    return;
  }

  const id = args.runId ?? (await store.latestRunId());
  if (id === null) throw new Error('No snapshot found. Run `npm run collect` first.');
  const snapshot = await store.loadSnapshot(id);
  const analysis = analyse(snapshot, profile, now, await loadInputs(profile));

  if (command === 'analyze') {
    printSummary(analysis, null);
    return;
  }
  const paths = await report(analysis, profile, store, now);
  printSummary(analysis, paths);
}

function printSummary(
  analysis: ReturnType<typeof analyse>,
  paths: { markdownPath: string; jsonPath: string } | null,
): void {
  console.log('');
  console.log(`Defects in scope: ${analysis.scope.included.length}/${analysis.scope.totalBefore}`);
  console.log(`Q1 data fitness:  ${(analysis.fitness.q1 * 100).toFixed(1)}%`);
  console.log(`Metrics computed: ${analysis.metrics.filter((m) => m.status === 'computed').length}/${analysis.metrics.length}`);
  console.log(`Blind spots:      ${analysis.diagnosis.blindSpots.length}`);
  console.log('');
  for (const f of analysis.diagnosis.findings) {
    console.log(`[${f.severity.toUpperCase()}] ${f.title} (${f.confidence})`);
    console.log(`    ${f.diagnosis}`);
  }
  if (paths !== null) {
    console.log('');
    console.log(`Report: ${paths.markdownPath}`);
    console.log(`JSON:   ${paths.jsonPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});