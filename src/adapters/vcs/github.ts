import type { CollectResult, Period, VcsPort } from '../../ports/index.js';
import type { ProjectProfile } from '../../domain/profile.js';
import type { CommitInfo } from '../../domain/types.js';

interface GhCommitListItem { sha: string; commit: { message: string; author?: { date?: string } } }
interface GhCommitDetail {
  sha: string;
  commit: { message: string; author?: { date?: string } };
  files?: { filename: string; additions: number; deletions: number }[];
}

export class GitHubVcs implements VcsPort {
  readonly kind = 'github';

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async fetchCommits(profile: ProjectProfile, period: Period): Promise<CollectResult<CommitInfo>> {
    const { owner, repo, branch } = profile.vcs;
    if (owner === undefined || repo === undefined) {
      return { items: [], notes: ['GitHub owner/repo not configured; churn-based metrics disabled.'], unavailableFields: ['churn'] };
    }
    const notes: string[] = [];
    const shas: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${period.from}&until=${period.to}&per_page=100&page=${page}${branch === undefined ? '' : `&sha=${branch}`}`;
      const res = await this.fetchImpl(url, { headers: this.headers() });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        notes.push(`GitHub ${res.status} on commit list page ${page}: ${body.slice(0, 200)}`);
        break;
      }
      const body = (await res.json()) as GhCommitListItem[];
      if (body.length === 0) break;
      shas.push(...body.map((c) => c.sha));
      if (body.length < 100) break;
    }
    notes.push(`Listed ${shas.length} commits.`);

    // Per-commit detail is one request each - the expensive part. Cap it and say so.
    const cap = 800;
    const items: CommitInfo[] = [];
    for (const sha of shas.slice(0, cap)) {
      const res = await this.fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
        headers: this.headers(),
      });
      if (!res.ok) continue;
      const detail = (await res.json()) as GhCommitDetail;
      const files = detail.files ?? [];
      items.push({
        sha: detail.sha,
        authoredAt: detail.commit.author?.date ?? period.from,
        message: detail.commit.message,
        files: files.map((f) => f.filename),
        linesAdded: files.reduce((a, f) => a + f.additions, 0),
        linesDeleted: files.reduce((a, f) => a + f.deletions, 0),
        pullRequest: /#(\d+)/.exec(detail.commit.message)?.[1] ?? null,
      });
    }
    if (shas.length > cap) notes.push(`Commit detail capped at ${cap}; churn figures cover that subset only.`);
    return { items, notes, unavailableFields: [] };
  }
}
