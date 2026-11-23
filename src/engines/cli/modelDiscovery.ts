import { killTree, spawnCli } from '../../core/process';
import { LineSplitter } from '../../core/sse';
import { toEffortLevels } from '../../shared/effort';
import type { ModelInfo } from '../../shared/types';

/**
 * Ask a CLI which models the signed-in account can use. Claude Code answers its SDK
 * `initialize` control request with the models of the user's plan (with their real names,
 * e.g. "Opus 5.5" behind the `opus` alias); Codex's app-server answers `model/list`.
 */

/** Start a JSON-lines process, send `lines`, and return the first message `pick` accepts. */
export function queryJsonLines<T>(file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; lines: (send: (msg: unknown) => void) => void; pick: (msg: Record<string, unknown>, send: (msg: unknown) => void) => T | undefined; timeoutMs?: number }): Promise<T | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(file, args, { env: opts.env, cwd: opts.cwd });
    } catch {
      return resolve(undefined);
    }
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs ?? 30_000);
    const send = (msg: unknown) => {
      if (!done) child.stdin.write(JSON.stringify(msg) + '\n');
    };
    const out = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      for (const line of out.push(d)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const value = opts.pick(JSON.parse(t) as Record<string, unknown>, send);
          if (value !== undefined) return finish(value);
        } catch {
          /* not JSON, or not ours */
        }
      }
    });
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.on('error', () => finish(undefined));
    child.on('close', () => finish(undefined));
    opts.lines(send);
  });
}

export interface ClaudeModelEntry {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export interface ClaudeInitInfo {
  models: ClaudeModelEntry[];
  commands: string[];
}

/** Models (and slash commands) of the signed-in Claude account, from the CLI's `initialize` response. */
export async function claudeInitInfo(exe: string, env: NodeJS.ProcessEnv, cwd: string | undefined): Promise<ClaudeInitInfo | undefined> {
  // No prompt is sent, so nothing reaches the API; --strict-mcp-config keeps MCP servers from starting.
  return queryJsonLines<ClaudeInitInfo>(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'], {
    env,
    cwd,
    lines: (send) => send({ type: 'control_request', request_id: 'ochub_init', request: { subtype: 'initialize' } }),
    pick: (msg) => {
      if (msg.type !== 'control_response') return undefined;
      const r = msg.response as { request_id?: string; subtype?: string; response?: { models?: ClaudeModelEntry[]; commands?: { name: string }[] } } | undefined;
      if (r?.request_id !== 'ochub_init') return undefined;
      if (r.subtype !== 'success' || !Array.isArray(r.response?.models)) return { models: [], commands: [] };
      return { models: r.response!.models!.filter((m) => m && typeof m.value === 'string'), commands: (r.response!.commands ?? []).map((c) => c.name).filter((n) => typeof n === 'string') };
    },
  });
}

/** "Opus 5.5 · Best for everyday… · $4/$20 per Mtok" → name "Opus 5.5", the rest as description. */
export function claudeModelInfo(m: ClaudeModelEntry): ModelInfo {
  // API prices ("$4/$20 per Mtok") are left out: on a subscription they are not what you pay.
  const parts = (m.description ?? '').split(' · ').map((x) => x.trim()).filter((x) => x && !/\$|per Mtok/i.test(x));
  const versioned = parts[0] && /\d/.test(parts[0]) && parts[0].length <= 40 ? parts[0] : undefined;
  let name: string;
  let description: string | undefined;
  if (m.value === 'default') {
    const current = /currently ([^)·]+?)\)/.exec(m.description ?? '')?.[1]?.trim();
    name = current ? `Default (${current})` : (m.displayName ?? 'Default');
    description = 'Claude Code picks the recommended model for your plan';
  } else {
    name = versioned ?? m.displayName ?? m.value;
    description = (versioned ? parts.slice(1) : parts).join(' · ') || undefined;
  }
  const info: ModelInfo = { providerId: 'claude-code', modelId: m.value, name, description, resolvedId: m.resolvedModel, supportsImages: true, supportsTools: true };
  const efforts = m.supportsEffort === false ? undefined : toEffortLevels(m.supportedEffortLevels);
  if (efforts) info.efforts = efforts;
  return info;
}

/** One released Claude model, read off its id: `claude-opus-5-5` is Opus 5.5. */
export interface ClaudeVersion {
  id: string;
  family: string;
  major: number;
  minor: number;
  /** "Opus 5.5" */
  name: string;
}

const FAMILY_RANK = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * The Claude versions among a list of model ids, most capable family first and newest
 * version first within a family. Dated snapshots (`-20251101`), speed variants (`-fast`) and
 * the old naming (`claude-3-5-sonnet`) are left out: each names a model this list already has.
 * A family that is new to the extension is read the same way, so it needs no code change.
 */
export function claudeVersions(ids: string[]): ClaudeVersion[] {
  const out: ClaudeVersion[] = [];
  for (const id of ids) {
    const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?$/.exec(id);
    if (!m) continue;
    const [, family, major, minor] = m;
    out.push({ id, family, major: Number(major), minor: Number(minor ?? 0), name: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor !== undefined ? `.${minor}` : ''}` });
  }
  const rank = (f: string) => (FAMILY_RANK.includes(f) ? FAMILY_RANK.indexOf(f) : FAMILY_RANK.length);
  return out.sort((a, b) => rank(a.family) - rank(b.family) || a.family.localeCompare(b.family) || b.major - a.major || b.minor - a.minor);
}

export interface CodexModelEntry {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities?: string[];
  supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[];
  defaultReasoningEffort?: string;
}

/** The reasoning-effort levels Codex lists for a model, and the one it uses by default. */
export function codexEfforts(m: CodexModelEntry): Pick<ModelInfo, 'efforts' | 'defaultEffort'> {
  const efforts = toEffortLevels((m.supportedReasoningEfforts ?? []).filter((e) => typeof e?.reasoningEffort === 'string').map((e) => ({ id: e.reasoningEffort!, description: e.description })));
  if (!efforts) return {};
  return efforts.some((e) => e.id === m.defaultReasoningEffort) ? { efforts, defaultEffort: m.defaultReasoningEffort } : { efforts };
}

/** Models of the signed-in Codex account, from `codex app-server` (`model/list`, all pages). */
export async function codexModels(exe: string, env: NodeJS.ProcessEnv, cwd: string | undefined, version: string): Promise<CodexModelEntry[] | undefined> {
  const all: CodexModelEntry[] = [];
  let page = 0;
  return queryJsonLines<CodexModelEntry[]>(exe, ['app-server'], {
    env,
    cwd,
    lines: (send) => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'opencode_hub', title: 'OpenCode Hub', version } } }),
    pick: (msg, send) => {
      if (msg.id === 1) {
        if (msg.error) return [];
        send({ jsonrpc: '2.0', method: 'initialized' });
        send({ jsonrpc: '2.0', id: 100, method: 'model/list', params: {} });
        return undefined;
      }
      if (typeof msg.id !== 'number' || msg.id < 100) return undefined;
      if (msg.error) return all;
      const result = msg.result as { data?: CodexModelEntry[]; nextCursor?: string | null } | undefined;
      all.push(...(result?.data ?? []));
      if (result?.nextCursor && ++page < 20) {
        send({ jsonrpc: '2.0', id: 100 + page, method: 'model/list', params: { cursor: result.nextCursor } });
        return undefined;
      }
      return all;
    },
  });
}
