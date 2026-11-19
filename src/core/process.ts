import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const isWindows = process.platform === 'win32';

/**
 * Resolve an executable the way a shell would: explicit path, then PATH (with PATHEXT on
 * Windows), then well-known install locations of the supported CLIs.
 */
export async function findExecutable(name: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (explicit && explicit.trim()) {
    const p = expandHome(explicit.trim());
    return (await isFile(p)) ? p : undefined;
  }
  const exts = isWindows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  dirs.push(
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.claude', 'local'),
    ...(isWindows ? [path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm')] : ['/usr/local/bin', '/opt/homebrew/bin']),
  );
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isFile(candidate)) return candidate;
      if (isWindows && (await isFile(path.join(dir, name + ext.toLowerCase())))) return path.join(dir, name + ext.toLowerCase());
    }
  }
  return undefined;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    if (!isWindows) await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Quote one argument for cmd.exe when a .cmd/.bat shim forces us through a shell. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Spawn a CLI. npm installs `.cmd` shims on Windows, which Node refuses to spawn without a
 * shell, so those go through cmd.exe with every argument quoted.
 */
export function spawnCli(file: string, args: string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    const line = [quoteWindowsArg(file), ...args.map(quoteWindowsArg)].join(' ');
    return spawn(line, [], { ...options, shell: true, windowsHide: true });
  }
  return spawn(file, args, { ...options, windowsHide: true });
}

/** Terminate a process and, on Windows, its children (shell-spawned CLIs leave orphans otherwise). */
export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000).unref();
  }
}

/** Run a command to completion and capture its output. */
export function runCapture(file: string, args: string[], options: SpawnOptionsWithoutStdio & { timeoutMs?: number; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCli(file, args, options);
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    const timer = options.timeoutMs ? setTimeout(() => killTree(child), options.timeoutMs) : undefined;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}
