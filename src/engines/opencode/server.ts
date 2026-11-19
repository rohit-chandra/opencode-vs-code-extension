import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EngineContext } from '../../core/engine';
import { EngineError } from '../../core/engine';
import { findExecutable, killTree, spawnCli } from '../../core/process';
import type { OpencodeConnection } from './client';

export interface RunningServer {
  connection: OpencodeConnection;
  /** True when we spawned the process (and must stop it). */
  owned: boolean;
  version?: string;
  stop(): void;
  onExit(listener: (reason: string) => void): void;
}

const START_TIMEOUT_MS = 45_000;

/** Start `opencode serve` for the workspace, or attach to a configured server. */
export async function startOpencodeServer(ctx: EngineContext, directory: string): Promise<RunningServer> {
  const attachUrl = ctx.config<string>('opencode.serverUrl', '').trim();
  if (attachUrl) {
    const password = ctx.config<string>('opencode.serverPassword', '') || (ctx.env ?? process.env).OPENCODE_SERVER_PASSWORD || undefined;
    const connection: OpencodeConnection = { baseUrl: attachUrl, directory, password, username: (ctx.env ?? process.env).OPENCODE_SERVER_USERNAME };
    const version = await probe(connection);
    ctx.log.info(`Attached to opencode server ${attachUrl} (v${version ?? '?'})`);
    return { connection, owned: false, version, stop: () => undefined, onExit: () => undefined };
  }

  const env = { ...(ctx.env ?? process.env) };
  const exe = await findExecutable('opencode', ctx.config<string>('opencode.path', ''), env);
  if (!exe) {
    throw new EngineError(
      'opencode is not installed (or not on PATH).',
      'Install it with `npm i -g opencode-ai` or from https://opencode.ai, or set "opencodeHub.opencode.path". You can also switch to another engine with /engine.',
    );
  }
  // Protect the local server: it can run tools in the workspace, so do not leave it open to other local processes.
  const password = randomBytes(24).toString('base64url');
  env.OPENCODE_SERVER_PASSWORD = password;
  env.OPENCODE_SERVER_USERNAME = 'opencode';
  env.OPENCODE_CLIENT = 'vscode-opencode-hub';

  ctx.log.info(`Starting ${exe} serve in ${directory}`);
  const child = spawnCli(exe, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directory, env });
  const exitListeners: ((reason: string) => void)[] = [];
  let exited = false;
  let stderrTail = '';

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    let found = false;
    const timer = setTimeout(() => {
      killTree(child);
      reject(new EngineError(`opencode serve did not start within ${START_TIMEOUT_MS / 1000}s.`, stderrTail.trim().slice(-600) || undefined));
    }, START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      if (found) return; // keep draining the pipe, but stop buffering once the URL is known
      out += chunk.toString();
      const m = /listening on\s+(https?:\/\/[^\s]+)/i.exec(out);
      if (m) {
        found = true;
        out = '';
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      onData(chunk);
      for (const line of text.split(/\r?\n/)) if (line.trim() && !/OPENCODE_SERVER_PASSWORD/.test(line)) ctx.log.debug(`[opencode] ${line}`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new EngineError(`Failed to start opencode: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      exited = true;
      clearTimeout(timer);
      const reason = `opencode serve exited (${signal ?? code})`;
      reject(new EngineError(reason, stderrTail.trim().slice(-600) || undefined));
      for (const l of exitListeners) l(reason);
    });
  });

  const connection: OpencodeConnection = { baseUrl, directory, username: 'opencode', password };
  let version: string | undefined;
  try {
    version = await probe(connection);
  } catch (err) {
    killTree(child as ChildProcessWithoutNullStreams);
    throw err;
  }
  ctx.log.info(`opencode server ready at ${baseUrl} (v${version ?? '?'})`);
  return {
    connection,
    owned: true,
    version,
    stop: () => {
      if (!exited) killTree(child as ChildProcessWithoutNullStreams);
    },
    onExit: (l) => exitListeners.push(l),
  };
}

async function probe(conn: OpencodeConnection): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  if (conn.password) headers.authorization = 'Basic ' + Buffer.from(`${conn.username ?? 'opencode'}:${conn.password}`).toString('base64');
  const base = conn.baseUrl.endsWith('/') ? conn.baseUrl : conn.baseUrl + '/';
  let lastError = 'no response';
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(new URL('global/health', base), { headers, signal: AbortSignal.timeout(3000) });
      if (res.status === 401) throw new EngineError('opencode server rejected the credentials (set opencodeHub.opencode.serverPassword).');
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { version?: string };
        return j.version;
      }
      // Older servers have no /global/health; any answer from /config proves the server is up.
      const cfg = await fetch(new URL('config', base), { headers, signal: AbortSignal.timeout(3000) });
      if (cfg.ok) return undefined;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof EngineError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new EngineError(`Could not reach the opencode server at ${conn.baseUrl}: ${lastError}`);
}
