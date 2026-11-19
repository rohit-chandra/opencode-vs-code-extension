import type { SlashCommand } from '../shared/types';

/** Commands handled by the extension itself, available for every engine. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new session', source: 'builtin' },
  { name: 'sessions', description: 'Switch to another session', source: 'builtin' },
  { name: 'model', description: 'Choose the model', source: 'builtin', argumentHint: '[name]' },
  { name: 'agent', description: 'Choose the agent', source: 'builtin', argumentHint: '[name]' },
  { name: 'engine', description: 'Switch engine (opencode, BYOK, Claude Code, Codex, Copilot)', source: 'builtin', argumentHint: '[name]' },
  { name: 'mcp', description: 'Show MCP servers and toggle them', source: 'builtin' },
  { name: 'usage', description: 'Show token usage for this session and overall', source: 'builtin' },
  { name: 'attach', description: 'Attach files to the next message', source: 'builtin' },
  { name: 'compact', description: 'Summarize the conversation to free up context', source: 'builtin' },
  { name: 'undo', description: 'Revert the last message and its file changes', source: 'builtin' },
  { name: 'redo', description: 'Restore reverted messages', source: 'builtin' },
  { name: 'share', description: 'Create a share link for this session', source: 'builtin' },
  { name: 'unshare', description: 'Remove the share link', source: 'builtin' },
  { name: 'fork', description: 'Fork this session', source: 'builtin' },
  { name: 'rename', description: 'Rename this session', source: 'builtin', argumentHint: '<title>' },
  { name: 'export', description: 'Export this session as Markdown', source: 'builtin' },
  { name: 'providers', description: 'Connect providers and manage API keys', source: 'builtin' },
  { name: 'auto', description: 'Auto mode: the agent proceeds without asking for approval', source: 'builtin' },
  { name: 'ask', description: 'Ask mode: approve tool calls, commands and edits yourself', source: 'builtin' },
  { name: 'login', description: 'Sign in with your Claude / ChatGPT account, or use an API key', source: 'builtin' },
  { name: 'stop', description: 'Stop the current response', source: 'builtin' },
  { name: 'avatar', description: 'Show, hide or restyle the 3D companion', source: 'builtin', argumentHint: '[on|off|buddy|dots]' },
  { name: 'move', description: 'Dock the chat left, right, or open it as an editor tab', source: 'builtin', argumentHint: '[left|right|editor]' },
  { name: 'zoom', description: 'Make the chat text larger or smaller', source: 'builtin', argumentHint: '[in|out|reset|120%]' },
  { name: 'clear', description: 'Clear the chat (starts a new session)', source: 'builtin' },
  { name: 'help', description: 'List available commands', source: 'builtin' },
];

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

export const isBuiltin = (name: string): boolean => BUILTIN_NAMES.has(name);

export interface ParsedSlash {
  name: string;
  args: string;
}

/** Parse `/name args...`. Returns undefined for normal text (including paths such as `/usr/bin`). */
export function parseSlash(text: string): ParsedSlash | undefined {
  const m = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

/** Built-ins first; engine commands that collide with a built-in are hidden. */
export function mergeCommands(engineCommands: SlashCommand[]): SlashCommand[] {
  const seen = new Set(BUILTIN_NAMES);
  const out = [...BUILTIN_COMMANDS];
  for (const c of engineCommands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ ...c, description: truncate(c.description, 140) });
  }
  return out;
}

export function truncate(text: string, max: number): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

/** Rank commands for the autocomplete popup: prefix matches, then substring, then description. */
export function filterCommands(commands: SlashCommand[], query: string, limit = 50): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored: { c: SlashCommand; s: number }[] = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    let s = -1;
    if (n === q) s = 0;
    else if (n.startsWith(q)) s = 1;
    else if (n.includes(q)) s = 2;
    else if (c.description.toLowerCase().includes(q)) s = 3;
    if (s >= 0) scored.push({ c, s });
  }
  scored.sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((x) => x.c);
}

export function helpMarkdown(commands: SlashCommand[]): string {
  const lines = ['**Commands**', ''];
  for (const c of commands) {
    lines.push(`- \`/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}\` — ${c.description}${c.source === 'builtin' ? '' : ` _(${c.source})_`}`);
  }
  lines.push('', 'Type `@` to mention a file, or drop files onto the chat to attach them.');
  return lines.join('\n');
}
