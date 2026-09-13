import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { METRIC_DOCS, BLOCK_DOCS } from './metric-docs.js';

/**
 * A deliberately small local UI.
 *
 * It does not reimplement anything: every action shells out to the same CLI
 * commands you would type, so there is exactly one code path and the UI cannot
 * drift from it. No framework, no build step, no new dependencies.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const ROOT = process.cwd();
const PROFILE = process.env['QA_PROFILE'] ?? 'config/profile.json';
const DATA = process.env['QA_DATA'] ?? 'data';
const PORT = Number.parseInt(process.env['QA_UI_PORT'] ?? '4321', 10);

/** Commands the UI is allowed to run. Anything else is rejected. */
const ALLOWED = ['check', 'fields', 'releases', 'scope', 'collect', 'doctor', 'report', 'analyze', 'runs'] as const;
type Allowed = (typeof ALLOWED)[number];

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res: ServerResponse, file: string): Promise<void> {
  const path = join(PUBLIC, file);
  if (!path.startsWith(PUBLIC) || !existsSync(path)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain; charset=utf-8' });
  res.end(await readFile(path));
}

/**
 * Runs a CLI command and streams its output back as plain text.
 *
 * Streaming matters for `collect`: it can take minutes on a large project, and
 * a spinner with no output looks identical to a hang.
 */
function runCommand(command: Allowed, res: ServerResponse): void {
  const args = ['tsx'];
  if (existsSync(resolve('.env'))) args.push('--env-file=.env');
  args.push('src/cli/index.ts', command, '--profile', PROFILE, '--out', DATA);

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const child = spawn('npx', args, { cwd: ROOT, env: process.env });
  child.stdout.on('data', (d: Buffer) => res.write(d));
  child.stderr.on('data', (d: Buffer) => res.write(d));
  child.on('error', (err) => {
    res.write(`\nFailed to start: ${err.message}\n`);
    res.end();
  });
  child.on('close', (code) => {
    res.write(`\n--- exit code ${code ?? 0} ---\n`);
    res.end();
  });
}

/** The most recent machine-readable report, which drives the report tabs. */
async function latestAnalysis(): Promise<unknown> {
  const reportsDir = resolve(DATA, 'reports');
  if (!existsSync(reportsDir)) return null;
  const runs = (await readdir(reportsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const runId of [...runs].reverse()) {
    const files = (await readdir(join(reportsDir, runId))).filter((f) => f.endsWith('.json')).sort();
    const newest = files[files.length - 1];
    if (newest === undefined) continue;
    const parsed = JSON.parse(await readFile(join(reportsDir, runId, newest), 'utf8')) as Record<string, unknown>;
    return { ...parsed, file: join('data', 'reports', runId, newest) };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/') return serveStatic(res, 'index.html');
  if (path === '/run') return serveStatic(res, 'run.html');
  if (path === '/guide') return serveStatic(res, 'guide.html');
  if (path === '/app.css') return serveStatic(res, 'app.css');

  if (path === '/api/profile' && req.method === 'GET') {
    const file = resolve(PROFILE);
    if (!existsSync(file)) {
      return sendJson(res, 200, { exists: false, path: file, profile: null });
    }
    try {
      return sendJson(res, 200, {
        exists: true,
        path: file,
        profile: JSON.parse(await readFile(file, 'utf8')) as unknown,
      });
    } catch (error) {
      return sendJson(res, 200, {
        exists: true,
        path: file,
        profile: null,
        error: error instanceof Error ? error.message : 'invalid JSON',
      });
    }
  }

  if (path === '/api/profile' && req.method === 'PUT') {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON' });
    }
    const file = resolve(PROFILE);
    await mkdir(dirname(file), { recursive: true });
    // A profile is version-controlled config; keep the previous one next to it
    // so a bad edit in the browser is one file copy away from being undone.
    if (existsSync(file)) {
      await writeFile(`${file}.bak`, await readFile(file, 'utf8'), 'utf8');
    }
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return sendJson(res, 200, { saved: true, path: file });
  }

  if (path.startsWith('/api/run/') && req.method === 'POST') {
    const command = path.slice('/api/run/'.length) as Allowed;
    if (!(ALLOWED as readonly string[]).includes(command)) {
      return sendJson(res, 400, { error: `Command "${command}" is not allowed.` });
    }
    return runCommand(command, res);
  }

  if (path === '/api/analysis' && req.method === 'GET') {
    return sendJson(res, 200, { analysis: await latestAnalysis() });
  }

  if (path === '/api/docs' && req.method === 'GET') {
    return sendJson(res, 200, { metrics: METRIC_DOCS, blocks: BLOCK_DOCS });
  }

  res.writeHead(404).end('Not found');
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
}).listen(PORT, () => {
  console.log(`\nqa-metrics UI\n  config   http://localhost:${PORT}/\n  run      http://localhost:${PORT}/run\n`);
  console.log(`  profile  ${resolve(PROFILE)}\n  data     ${resolve(DATA)}\n`);
});