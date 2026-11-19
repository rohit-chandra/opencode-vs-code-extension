import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const isWindows = process.platform === 'win32';

/**
 * Resolve an executable the way a shell would: explicit path, then PATH (with PATHEXT on
 * Windows), then the places the supported CLIs and Node version managers install to.
 *
 * The extra places matter on macOS and Linux: an editor started from the Dock or a desktop
 * launcher does not always get the PATH your terminal has, so a CLI installed with nvm,
 * Volta, Homebrew or a `curl | sh` installer would otherwise look missing.
 */
export async function findExecutable(name: string, explicit?: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (explicit && explicit.trim()) {
    const p = expandHome(explicit.trim());
    return (await isFile(p)) ? p : undefined;
  }
  const windows = platform === 'win32';
  const exts = windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = [...pathDirs(env, platform), ...(await wellKnownDirs(home, env, platform))];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isFile(candidate)) return candidate;
      if (windows && (await isFile(path.join(dir, name + ext.toLowerCase())))) return path.join(dir, name + ext.toLowerCase());
    }
  }
  return undefined;
}

/** The value of PATH, whatever its letter case (`Path` on Windows). */
function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key && env[key]) || '';
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return pathValue(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/**
 * Install locations that are often missing from the PATH of an editor started from the GUI:
 * the CLIs' own installers, Node version managers and system package managers.
 */
export async function wellKnownDirs(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const h = (...parts: string[]) => path.join(home, ...parts);
  const shared = [h('.opencode', 'bin'), h('.local', 'bin'), h('.bun', 'bin'), h('.npm-global', 'bin'), h('.claude', 'local'), h('.claude', 'bin'), h('.codex', 'bin'), h('.volta', 'bin'), h('.cargo', 'bin'), h('.deno', 'bin')];
  if (platform === 'win32') {
    const appData = env.APPDATA ?? h('AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? h('AppData', 'Local');
    return [...shared, path.join(appData, 'npm'), path.join(local, 'pnpm'), path.join(local, 'Volta', 'bin'), path.join(local, 'Microsoft', 'WinGet', 'Links'), h('scoop', 'shims')];
  }
  const dirs = [
    ...shared,
    h('.yarn', 'bin'),
    h('.asdf', 'shims'),
    h('.local', 'share', 'mise', 'shims'),
    h('.local', 'share', 'pnpm'),
    h('.nix-profile', 'bin'),
    h('n', 'bin'),
  ];
  // Node version managers keep one folder per Node version; npm's global CLIs live inside. Newest first.
  dirs.push(...(await versionDirs(env.NVM_DIR ? path.join(env.NVM_DIR, 'versions', 'node') : h('.nvm', 'versions', 'node'), 'bin')));
  dirs.push(...(await versionDirs(h('.local', 'share', 'fnm', 'node-versions'), path.join('installation', 'bin'))));
  if (platform === 'darwin') {
    dirs.push(h('Library', 'pnpm'), ...(await versionDirs(h('Library', 'Application Support', 'fnm', 'node-versions'), path.join('installation', 'bin'))));
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin');
  } else {
    dirs.push('/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', h('.linuxbrew', 'bin'), '/snap/bin', '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin');
  }
  return dirs;
}

/** `<root>/<version>/<sub>` for every version folder, highest version first. */
async function versionDirs(root: string, sub: string): Promise<string[]> {
  try {
    const names = (await fs.readdir(root)).filter((n) => /^v?\d/.test(n));
    names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return names.map((n) => path.join(root, n, sub));
  } catch {
    return [];
  }
}

/**
 * The command to type in a terminal for an executable we found: its plain name when the
 * terminal can find it too (its folder is on PATH), otherwise the full path.
 */
export function terminalCommand(name: string, exe: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (!exe) return name;
  const dir = path.dirname(exe);
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const clean = (d: string) => (d.length > 1 ? d.replace(/[\\/]+$/, '') : d);
  return pathDirs(env, platform).some((d) => same(clean(d), dir)) ? name : exe;
}

/**
 * Environment for running `exe`: the same, with the executable's own folder on PATH.
 * npm installs CLIs as `#!/usr/bin/env node` scripts next to the `node` they belong to
 * (nvm, Volta, fnm), so without this a CLI we found in such a folder cannot start when
 * the editor's PATH lacks it.
 */
export function envWithExeDir(exe: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (!path.isAbsolute(exe)) return env;
  const dir = path.dirname(exe);
  const sep = platform === 'win32' ? ';' : ':';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  const has = current.split(sep).some((d) => (platform === 'win32' ? d.toLowerCase() === dir.toLowerCase() : d === dir));
  return has ? env : { ...env, [key]: current ? `${dir}${sep}${current}` : dir };
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
  options = { ...options, env: envWithExeDir(file, options.env ?? process.env) };
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
