import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CollectResult, Period, VcsPort } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { CommitInfo } from '../../domain/types.js';

const run = promisify(execFile);

/** Field separators unlikely to appear in a commit message. */
const REC = '\u001e';
const FLD = '\u001f';

export interface GitTag {
  readonly name: string;
  /** Tagger date for annotated tags, commit date for lightweight ones. */
  readonly date: string;
}

/**
 * Reads history from a local clone via `git log`.
 *
 * Preferred over the GitHub adapter: one process instead of one HTTP request
 * per commit, no rate limit, and the repository never leaves the machine.
 * It is also the only source that can support SZZ later - blame needs local
 * history, not an API.
 */
export class LocalGitVcs implements VcsPort {
  readonly kind = 'local-git';

  constructor(
    private readonly repoPath: string,
    private readonly maxBufferMb = 256,
  ) {}

  private async git(args: readonly string[]): Promise<string> {
    const { stdout } = await run('git', ['-C', this.repoPath, ...args], {
      maxBuffer: this.maxBufferMb * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  }

  /**
   * Release tags with their dates.
   *
   * Tags are the cheapest authoritative record of when a version actually
   * shipped - far better than reconstructing dates from defect activity, which
   * only tells you when people were working, not when users got the build.
   */
  async fetchTags(): Promise<readonly GitTag[]> {
    if (!existsSync(resolve(this.repoPath))) return [];
    try {
      const raw = await this.git([
        'for-each-ref',
        '--sort=creatordate',
        '--format=%(refname:short)\t%(creatordate:iso-strict)',
        'refs/tags',
      ]);
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [name, date] = line.split('\t');
          return { name: name ?? '', date: date ?? '' };
        })
        .filter((t) => t.name !== '' && t.date !== '');
    } catch {
      return [];
    }
  }

  /** Branch names are the most common misconfiguration; fail loudly and usefully. */
  private async resolveRef(branch: string | undefined, notes: string[]): Promise<string> {
    if (branch === undefined || branch.trim() === '') return '--all';
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
      return branch;
    } catch {
      let available = '';
      try {
        const raw = await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
        available = raw.split('\n').map((x) => x.trim()).filter((x) => x !== '').slice(0, 15).join(', ');
      } catch {
        available = 'could not list refs';
      }
      notes.push(
        `Branch "${branch}" does not exist in this clone. Falling back to --all (every ref). Available: ${available}.`,
      );
      return '--all';
    }
  }

  async fetchCommits(profile: ProjectProfile, period: Period): Promise<CollectResult<CommitInfo>> {
    const path = resolve(this.repoPath);
    const notes: string[] = [];
    if (!existsSync(path)) {
      return { items: [], notes: [`Local repository not found at ${path}; churn metrics disabled.`], unavailableFields: ['churn'] };
    }

    try {
      await this.git(['rev-parse', '--git-dir']);
    } catch {
      return {
        items: [],
        notes: [`${path} is not inside a git repository; churn metrics disabled.`],
        unavailableFields: ['churn'],
      };
    }

    try {
      const shallow = (await this.git(['rev-parse', '--is-shallow-repository'])).trim();
      if (shallow === 'true') {
        notes.push(
          'Repository is a SHALLOW clone. Churn is truncated and blame-based analysis (SZZ) will be wrong. Re-clone with full history or run `git fetch --unshallow`.',
        );
      }
    } catch {
      notes.push('Could not determine clone depth.');
    }

    const ref = await this.resolveRef(profile.vcs.branch, notes);

    // The record separator must PREFIX the header: git emits --numstat lines
    // after the pretty format, so a trailing separator would cut each commit
    // away from its own file statistics.
    const format = REC + ['%H', '%aI', '%s%n%b'].join(FLD);
    const args = [
      'log',
      ref,
      `--since=${period.from}`,
      `--until=${period.to}`,
      '--numstat',
      '--no-merges',
      `--pretty=format:${format}`,
      // Everything after this is a path, never a revision. Without it a branch
      // name that matches a directory produces the "ambiguous argument" error.
      '--',
    ];

    let raw: string;
    try {
      raw = await this.git(args);
    } catch (error) {
      return {
        items: [],
        notes: [...notes, `git log failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`],
        unavailableFields: ['churn'],
      };
    }

    const items: CommitInfo[] = [];
    let binaryFiles = 0;
    for (const record of raw.split(REC)) {
      const trimmed = record.replace(/^\n+/, '');
      if (trimmed.trim() === '') continue;
      const [sha, authoredAt, rest] = trimmed.split(FLD);
      if (sha === undefined || authoredAt === undefined || rest === undefined) continue;

      const lines = rest.split('\n');
      const message: string[] = [];
      const files: string[] = [];
      let added = 0;
      let deleted = 0;
      let inStats = false;

      for (const line of lines) {
        const stat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (stat === null) {
          if (!inStats) message.push(line);
          continue;
        }
        inStats = true;
        const [, a, d, file] = stat;
        if (a === '-' || d === '-') binaryFiles += 1;
        else {
          added += Number.parseInt(a as string, 10);
          deleted += Number.parseInt(d as string, 10);
        }
        files.push(normalisePath(file as string));
      }

      const text = message.join('\n').trim();
      items.push({
        sha,
        authoredAt,
        message: text,
        files,
        linesAdded: added,
        linesDeleted: deleted,
        pullRequest: extractPullRequest(text),
      });
    }

    notes.push(
      `Read ${items.length} commits from local clone at ${path} (${ref === '--all' ? 'all refs' : `ref ${ref}`}).`,
    );
    if (items.length === 0) {
      notes.push(
        'Zero commits in the period. Check that the clone is up to date and that the period matches actual activity.',
      );
    }
    if (binaryFiles > 0) notes.push(`${binaryFiles} binary file change(s) contributed no line counts.`);
    notes.push('Merge commits excluded: their line counts double-count the branch and inflate churn.');
    return { items, notes, unavailableFields: [] };
  }
}

/**
 * `git log --numstat` writes renames as `old => new` or `dir/{old => new}/file`.
 * Keep the destination path, otherwise a rename registers as a phantom hotspot.
 */
export function normalisePath(raw: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced !== null) {
    const [, prefix, , to, suffix] = braced;
    return `${prefix ?? ''}${to ?? ''}${suffix ?? ''}`.replace(/\/\//g, '/');
  }
  const plain = /^(.*) => (.*)$/.exec(raw);
  if (plain !== null) return (plain[2] ?? raw).trim();
  return raw;
}

/** Recognises both GitHub (`#123`) and Azure DevOps (`Merged PR 123:`) conventions. */
export function extractPullRequest(message: string): string | null {
  const ado = /Merged PR (\d+)/i.exec(message);
  if (ado !== null) return ado[1] ?? null;
  const gh = /(?:^|[\s([])#(\d+)/.exec(message);
  return gh?.[1] ?? null;
}