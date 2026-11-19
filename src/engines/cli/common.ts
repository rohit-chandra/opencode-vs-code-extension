import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { killTree, spawnCli } from '../../core/process';
import { LineSplitter } from '../../core/sse';
import { isImageMime } from '../../core/attachments';
import type { Attachment, PromptInput } from '../../shared/types';

export interface JsonlRun {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal: AbortSignal;
  onEvent(event: Record<string, unknown>): void;
  /** Lines on stdout that are not JSON (banners, warnings). */
  onText?(line: string): void;
}

/** Run a CLI that prints one JSON object per line and feed each object to `onEvent`. */
export function runJsonl(run: JsonlRun): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (run.signal.aborted) return resolve({ code: null, stderr: '' });
    const child = spawnCli(run.file, run.args, { cwd: run.cwd, env: run.env });
    const out = new LineSplitter();
    let stderr = '';
    const onAbort = () => killTree(child);
    run.signal.addEventListener('abort', onAbort, { once: true });
    const feed = (lines: string[]) => {
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('{')) {
          try {
            run.onEvent(JSON.parse(t) as Record<string, unknown>);
            continue;
          } catch {
            /* fall through */
          }
        }
        run.onText?.(t);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => feed(out.push(d)));
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-8000)));
    child.on('error', (err) => {
      run.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      run.signal.removeEventListener('abort', onAbort);
      feed(out.end());
      resolve({ code, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(run.stdin ?? '');
  });
}

/**
 * Prompt text for agents that read files themselves: files are referenced by path,
 * selections and pasted text are inlined. Images are returned separately.
 */
export function promptForAgent(input: PromptInput): { text: string; images: Attachment[] } {
  const images: Attachment[] = [];
  const refs: string[] = [];
  const inline: string[] = [];
  for (const a of input.attachments) {
    if (isImageMime(a.mime)) images.push(a);
    else if (a.path) refs.push(`- ${a.path}${a.range ? ` (lines ${a.range.startLine}-${a.range.endLine})` : ''}`);
    else if (a.text !== undefined) inline.push(`<attachment name="${a.name}">\n${a.text}\n</attachment>`);
    if (a.path && a.kind === 'selection' && a.text !== undefined) inline.push(`<selection file="${a.name}">\n${a.text}\n</selection>`);
  }
  const sections = [input.text];
  if (refs.length) sections.push(`Attached files (read them as needed):\n${refs.join('\n')}`);
  sections.push(...inline);
  return { text: sections.filter(Boolean).join('\n\n'), images };
}

export async function imageBase64(a: Attachment): Promise<{ mime: string; data: string } | undefined> {
  if (a.dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(a.dataUrl);
    return m ? { mime: m[1], data: m[2] } : undefined;
  }
  if (!a.path) return undefined;
  try {
    return { mime: a.mime, data: (await fs.readFile(a.path)).toString('base64') };
  } catch {
    return undefined;
  }
}

/** Small JSON state file per CLI engine (disabled MCP servers, cached slash commands). */
export class StateFile<T extends object> {
  private data: T | undefined;
  constructor(private readonly file: string, private readonly initial: T) {}

  async read(): Promise<T> {
    if (this.data) return this.data;
    try {
      this.data = { ...this.initial, ...(JSON.parse(await fs.readFile(this.file, 'utf8')) as T) };
    } catch {
      this.data = { ...this.initial };
    }
    return this.data;
  }

  async update(patch: Partial<T>): Promise<T> {
    const next = { ...(await this.read()), ...patch };
    this.data = next;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
