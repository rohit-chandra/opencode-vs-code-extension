import { useEffect, useState } from 'preact/hooks';
import type { ViewState } from '../../src/shared/protocol';
import type { Mood, Reaction, WorkKind } from './avatar/face';
import { store } from './store';

export function useStore(): ViewState {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
  return store.state;
}

/** Re-render on an interval while `active` (used for moods that depend on elapsed time). */
export function useTick(active: boolean, ms: number): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

export interface MoodInfo {
  mood: Mood;
  caption: string;
  work: WorkKind;
}

/** Which prop fits a tool: hammer for running things, pencil for edits, magnifying glass for lookups. */
export function workKind(tool: string): WorkKind {
  const t = tool.toLowerCase();
  if (/(edit|write|patch|apply|replace|create|notebook|todo)/.test(t)) return 'edit';
  if (/(read|grep|glob|search|find|list|ls|fetch|web|view|open|lookup|query|get)/.test(t)) return 'search';
  return 'build';
}

const SLEEP_AFTER_MS = 3 * 60_000;

interface Tracker {
  activity: ViewState['activity'];
  sessionId: string | undefined;
  /** tool call id -> last seen status, for the turn in progress */
  tools: Map<string, string>;
  toolOk: number;
  toolFailed: number;
  until: number;
  result: 'happy' | 'excited' | 'sad' | undefined;
  noticeNonce: number;
  lastActive: number;
  work: WorkKind;
}
const tr: Tracker = { activity: 'idle', sessionId: undefined, tools: new Map(), toolOk: 0, toolFailed: 0, until: 0, result: undefined, noticeNonce: 0, lastActive: Date.now(), work: 'build' };
const reactions: Reaction[] = [];

/** One-off reactions (a tool finished or failed) collected since the last call. */
export function takeReactions(): Reaction[] {
  return reactions.splice(0);
}

/**
 * What Oki should be doing right now, and the status line shown next to it.
 * Called on every render; it keeps a little state to notice transitions (a tool that just
 * finished, a turn that just ended) and turn them into feelings.
 */
export function deriveMood(s: ViewState, now = Date.now()): MoodInfo {
  const busy = s.activity !== 'idle';
  const last = s.messages[s.messages.length - 1];
  // The turn in progress: every assistant message after the last thing the user said. Engines
  // such as opencode split one turn into several messages (tool call, then the answer).
  let turnStart = s.messages.length;
  while (turnStart > 0 && s.messages[turnStart - 1].role === 'assistant') turnStart--;
  const turn = s.messages.slice(turnStart);

  const sessionChanged = s.sessionId !== tr.sessionId;
  if (sessionChanged || (tr.activity === 'idle' && busy)) {
    // A new turn (or another session): whatever is on screen already is history, not news.
    // A session that gets its id on the first send keeps the turn it has just started.
    const sameTurn = sessionChanged && tr.sessionId === undefined && tr.activity !== 'idle';
    tr.sessionId = s.sessionId;
    if (!sameTurn) {
      tr.tools.clear();
      for (const m of s.messages) for (const p of m.parts) if (p.type === 'tool') tr.tools.set(p.callId, p.status);
      tr.toolOk = tr.toolFailed = 0;
      tr.result = undefined;
      if (sessionChanged) tr.activity = s.activity;
    }
  }
  if (busy) tr.lastActive = now;

  // Tool calls of the running turn: celebrate each success, wince at each failure.
  const ending = tr.activity !== 'idle' && !busy;
  if (busy || ending) {
    for (const m of turn) {
      for (const p of m.parts) {
        if (p.type !== 'tool') continue;
        if (tr.tools.get(p.callId) === p.status) continue;
        tr.tools.set(p.callId, p.status);
        if (p.status === 'completed') {
          tr.toolOk++;
          reactions.push('success');
        } else if (p.status === 'error') {
          tr.toolFailed++;
          reactions.push('fail');
        }
      }
    }
  }

  // A turn just ended: decide how Oki feels about it.
  if (ending) {
    const lastTool = turn.flatMap((m) => m.parts).reverse().find((p) => p.type === 'tool');
    const endedBadly = !!last?.error || (lastTool?.type === 'tool' && lastTool.status === 'error');
    if (endedBadly) {
      tr.result = 'sad';
      tr.until = now + 6000;
    } else if (tr.toolOk > 0) {
      tr.result = 'excited'; // something was actually built or run, and it worked
      tr.until = now + 3200;
    } else {
      tr.result = 'happy';
      tr.until = now + 1800;
    }
    tr.toolOk = tr.toolFailed = 0;
  }
  tr.activity = s.activity;

  if (s.notice && s.notice.nonce !== tr.noticeNonce) {
    tr.noticeNonce = s.notice.nonce;
    if (s.notice.level === 'error') {
      tr.result = 'sad';
      tr.until = now + 6000;
    }
  }

  const engine = s.engines.find((e) => e.engine === s.engine);
  if (s.permissions.length || s.questions.length) return { mood: 'waiting', caption: 'Needs your OK', work: tr.work };
  if (s.activity === 'retry') return { mood: 'thinking', caption: s.activityDetail ?? 'Retrying…', work: tr.work };
  if (busy) {
    const part = last?.role === 'assistant' ? last.parts[last.parts.length - 1] : undefined;
    if (part?.type === 'tool' && (part.status === 'running' || part.status === 'pending')) {
      tr.work = workKind(part.tool);
      const verb = tr.work === 'edit' ? 'Editing with' : tr.work === 'search' ? 'Looking with' : 'Running';
      return { mood: 'working', caption: `${verb} ${part.tool}…`, work: tr.work };
    }
    if (now - store.lastDelta < 700 && part?.type === 'text') return { mood: 'speaking', caption: 'Writing…', work: tr.work };
    return { mood: 'thinking', caption: 'Thinking…', work: tr.work };
  }
  if (tr.result && now < tr.until) {
    const caption = tr.result === 'sad' ? 'That did not work' : tr.result === 'excited' ? 'It worked!' : 'Done';
    return { mood: tr.result, caption, work: tr.work };
  }
  if (engine?.state === 'unavailable') return { mood: 'sad', caption: 'Engine not available', work: tr.work };
  if (s.loading || engine?.state === 'starting') return { mood: 'thinking', caption: 'Starting…', work: tr.work };
  if (now - store.typingAt < 1600) {
    tr.lastActive = now;
    return { mood: 'listening', caption: s.messages.length ? 'Listening' : 'What are we building?', work: tr.work };
  }
  if (now - Math.max(tr.lastActive, store.lastInteraction) > SLEEP_AFTER_MS) return { mood: 'sleepy', caption: 'Resting', work: tr.work };
  return { mood: 'idle', caption: s.messages.length ? 'Ready' : 'What are we building?', work: tr.work };
}

/** Time until the current timed mood ends, so the view can re-render exactly then. */
export function moodDeadline(now = Date.now()): number | undefined {
  const candidates = [tr.until, store.typingAt + 1600].filter((t) => t > now);
  return candidates.length ? Math.min(...candidates) - now : undefined;
}
