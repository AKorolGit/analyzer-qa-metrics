import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Snapshot } from '../../domain/types.js';
import type { SnapshotStorePort } from '../../ports/index.js';

/**
 * Append-only file store.
 * data/raw/<runId>/snapshot.json   - immutable collected input
 * out/reports/<runId>/report-<ts>.md|json - a NEW file on every generation
 * out/runs.jsonl                   - append-only ledger of every run
 */
export class FileSnapshotStore implements SnapshotStorePort {
  private readonly root: string;

  constructor(root = 'data') {
    this.root = resolve(root);
  }

  private rawDir(runId: string): string {
    return join(this.root, 'raw', runId);
  }

  private reportDir(runId: string): string {
    return join(this.root, 'reports', runId);
  }

  async saveSnapshot(snapshot: Snapshot): Promise<string> {
    const dir = this.rawDir(snapshot.runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'snapshot.json');
    if (existsSync(path)) {
      throw new Error(`Snapshot ${snapshot.runId} already exists; snapshots are immutable.`);
    }
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8');
    return path;
  }

  async loadSnapshot(runId: string): Promise<Snapshot> {
    const path = join(this.rawDir(runId), 'snapshot.json');
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as Snapshot;
  }

  async latestRunId(): Promise<string | null> {
    const dir = join(this.root, 'raw');
    if (!existsSync(dir)) return null;
    const entries = await readdir(dir, { withFileTypes: true });
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    return ids.length > 0 ? (ids[ids.length - 1] as string) : null;
  }

  async saveReport(runId: string, extension: string, content: string): Promise<string> {
    const dir = this.reportDir(runId);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let path = join(dir, `report-${stamp}.${extension}`);
    let counter = 1;
    while (existsSync(path)) {
      path = join(dir, `report-${stamp}-${counter}.${extension}`);
      counter += 1;
    }
    await writeFile(path, content, 'utf8');
    return path;
  }

  async appendRunLedger(entry: Readonly<Record<string, unknown>>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(join(this.root, 'runs.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
