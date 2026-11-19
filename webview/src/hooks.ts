import { useEffect, useState } from 'preact/hooks';
import type { ViewState } from '../../src/shared/protocol';
import type { Mood } from './avatar/face';
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
}

let lastActivity: ViewState['activity'] = 'idle';
let happyUntil = 0;
let errorUntil = 0;
let lastNoticeNonce = 0;

/** What Oki should be doing right now, and the status line shown next to it. */
export function deriveMood(s: ViewState, now = Date.now()): MoodInfo {
  if (lastActivity !== 'idle' && s.activity === 'idle') {
    const last = s.messages[s.messages.length - 1];
    if (last?.error) errorUntil = now + 4000;
    else happyUntil = now + 1600;
  }
  lastActivity = s.activity;
  if (s.notice && s.notice.nonce !== lastNoticeNonce) {
    lastNoticeNonce = s.notice.nonce;
    if (s.notice.level === 'error') errorUntil = now + 4000;
  }

  const engine = s.engines.find((e) => e.engine === s.engine);
  if (s.permissions.length || s.questions.length) return { mood: 'waiting', caption: 'Needs your OK' };
  if (s.activity === 'retry') return { mood: 'thinking', caption: s.activityDetail ?? 'Retrying…' };
  if (s.activity === 'busy') {
    const last = s.messages[s.messages.length - 1];
    const part = last?.role === 'assistant' ? last.parts[last.parts.length - 1] : undefined;
    if (part?.type === 'tool' && (part.status === 'running' || part.status === 'pending')) return { mood: 'tool', caption: `Running ${part.tool}…` };
    if (now - store.lastDelta < 700 && part?.type === 'text') return { mood: 'speaking', caption: 'Writing…' };
    return { mood: 'thinking', caption: 'Thinking…' };
  }
  if (now < errorUntil) return { mood: 'error', caption: 'Something went wrong' };
  if (engine?.state === 'unavailable') return { mood: 'error', caption: 'Engine not available' };
  if (s.loading || engine?.state === 'starting') return { mood: 'thinking', caption: 'Starting…' };
  if (now < happyUntil) return { mood: 'happy', caption: 'Done' };
  return { mood: 'idle', caption: s.messages.length ? 'Ready' : 'What are we building?' };
}
