import type { ChatMessage } from '../shared/types';

/**
 * A compact version of a chat session, for carrying its context into another session.
 *
 * It is made without calling a model: what the user asked, what the assistant answered and
 * which tools ran, each cut to a sensible length. Tool output and reasoning are left out,
 * because they are most of a session's size and little of its meaning. When the session is
 * still too long, the first request and the most recent exchanges are kept.
 */

const USER_MAX = 1200;
const ASSISTANT_MAX = 1800;
const TOOLS_MAX = 8;

function cut(text: string, max: number): string {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()} […]` : clean;
}

function entry(m: ChatMessage): string | undefined {
  // Messages the extension wrote itself (/help, /doctor) are not part of the conversation.
  if (m.id.startsWith('local_')) return undefined;
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();
  if (m.role === 'user') {
    const files = m.parts.filter((p) => p.type === 'file').map((p) => (p as { filename: string }).filename);
    const body = [cut(text, USER_MAX), files.length ? `(attached: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''})` : ''].filter(Boolean).join('\n');
    return body ? `### User\n${body}` : undefined;
  }
  const tools = m.parts.filter((p): p is Extract<ChatMessage['parts'][number], { type: 'tool' }> => p.type === 'tool');
  const used = tools.slice(0, TOOLS_MAX).map((t) => `${t.tool}${t.title ? ` (${cut(t.title, 60)})` : ''}${t.status === 'error' ? ' [failed]' : ''}`);
  const lines = [cut(text, ASSISTANT_MAX)];
  if (used.length) lines.push(`Tools used: ${used.join('; ')}${tools.length > TOOLS_MAX ? `; and ${tools.length - TOOLS_MAX} more` : ''}`);
  if (m.error) lines.push(`(this reply failed: ${cut(m.error, 200)})`);
  const body = lines.filter(Boolean).join('\n');
  return body ? `### Assistant\n${body}` : undefined;
}

export interface SessionDigest {
  text: string;
  /** Messages that made it into the digest, and how many the session has. */
  included: number;
  total: number;
}

/** Condensed transcript of `messages`, at most about `maxChars` characters long. */
export function sessionDigest(title: string, engineLabel: string, messages: ChatMessage[], maxChars = 12_000): SessionDigest {
  const entries = messages.map(entry).filter((e): e is string => !!e);
  const head = `Context from an earlier chat session: "${title}" (${engineLabel}). It is background for the conversation that follows, not a new request.`;
  let kept = entries;
  let skipped = 0;
  const size = (list: string[]) => list.reduce((n, e) => n + e.length + 2, 0);
  if (size(entries) > maxChars && entries.length > 2) {
    // Keep how it started and how it ended; drop from the middle.
    const first = entries[0];
    const tail: string[] = [];
    let used = first.length;
    for (let i = entries.length - 1; i > 0; i--) {
      if (used + entries[i].length + 2 > maxChars && tail.length >= 2) break;
      tail.unshift(entries[i]);
      used += entries[i].length + 2;
    }
    skipped = entries.length - 1 - tail.length;
    kept = skipped > 0 ? [first, `(… ${skipped} earlier ${skipped === 1 ? 'message' : 'messages'} left out …)`, ...tail] : entries;
  }
  return { text: [head, ...kept].join('\n\n'), included: entries.length - skipped, total: entries.length };
}
