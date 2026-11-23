/**
 * Send later: a chat message that waits for a time (or for the reply in progress) before it
 * is sent. This file holds the parts shared by the host and the webview: reading a time the
 * user typed, the presets of the menu and how a time is shown. No `vscode`, no Node.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Nothing is scheduled further ahead than this; a typo such as "300d" should not sit in the list for a year. */
export const MAX_AHEAD = 60 * DAY;
/** The hour "tomorrow" means when no time is given. */
const MORNING = 9;

export type WhenResult = { at: number; text: string } | { error: string };

const UNIT_MS: Record<string, number> = { d: DAY, h: HOUR, m: MINUTE, s: 1000 };
const DURATION = /^(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*/i;

function at(base: Date, hour: number, minute: number, addDays = 0): number {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, minute, 0, 0).getTime();
}

/** "9", "30", "pm" → 21:30. Undefined when it is not a time of day. */
function clock(h: string, m: string | undefined, half: string | undefined): { hour: number; minute: number } | undefined {
  let hour = Number(h);
  const minute = m ? Number(m) : 0;
  const ampm = half?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

/**
 * Read a time from the start of `input` and return it with the rest of the text, which is the
 * message to send. Understood, with or without a leading "in" / "at":
 *
 *   30m · 2h · 1h30m · 45 min · 2 days       a delay from now
 *   14:30 · 9am · 9:30pm                     the next time the clock shows it
 *   today 18:00 · tomorrow · tomorrow 9am    a day and a time (tomorrow alone means 9:00)
 *   2026-12-01 · 2026-12-01 14:30            a date, local time
 *   next · when done                         as soon as the reply in progress has finished
 */
export function parseWhen(input: string, now: number): WhenResult {
  const text = input.trim();
  const base = new Date(now);
  const done = (time: number, rest: string): WhenResult => {
    if (!Number.isFinite(time)) return { error: 'That is not a time I can read.' };
    if (time < now - MINUTE) return { error: 'That time has already passed.' };
    if (time - now > MAX_AHEAD) return { error: 'That is more than 60 days away. Pick a time closer to now.' };
    return { at: time, text: rest.trim() };
  };

  // As soon as the chat is free.
  const soon = /^(?:next|queue|when\s+(?:done|idle|free|finished)|after\s+this(?:\s+reply)?)(?![a-z])\s*/i.exec(text);
  if (soon) return done(now, text.slice(soon[0].length));

  // A delay: one or more number + unit pairs.
  let rest = text.replace(/^in\s+/i, '');
  let delay = 0;
  let pairs = 0;
  for (let m = DURATION.exec(rest); m; m = DURATION.exec(rest)) {
    delay += Number(m[1]) * UNIT_MS[m[2][0].toLowerCase()];
    rest = rest.slice(m[0].length);
    pairs++;
  }
  if (pairs > 0) return done(now + Math.round(delay), rest);

  // A date, with or without a time.
  const date = /^(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:]))?\s*/i.exec(text);
  if (date) {
    const time = date[4] ? clock(date[4], date[5], date[6]) : { hour: MORNING, minute: 0 };
    if (!time) return { error: 'That is not a time I can read.' };
    return done(new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), time.hour, time.minute).getTime(), text.slice(date[0].length));
  }

  // A day word and/or a time of day. A bare number ("5 files changed") is not a time: it needs
  // a colon, am/pm, a day word or "at" in front of it.
  const day = /^(today|tonight|tomorrow)(?![a-z])\s*/i.exec(text);
  const afterDay = day ? text.slice(day[0].length) : text;
  const tod = /^(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])\s*/i.exec(afterDay);
  const explicit = tod && (tod[1] || tod[3] !== undefined || tod[4] || day);
  if (tod && explicit) {
    const time = clock(tod[2], tod[3], tod[4]);
    if (!time) return { error: 'That is not a time I can read.' };
    const word = day?.[1].toLowerCase();
    let when = at(base, time.hour, time.minute, word === 'tomorrow' ? 1 : 0);
    // "9am" said at noon means tomorrow morning.
    if (!word && when <= now) when = at(base, time.hour, time.minute, 1);
    return done(when, afterDay.slice(tod[0].length));
  }
  if (day) {
    const word = day[1].toLowerCase();
    if (word === 'tomorrow') return done(at(base, MORNING, 0, 1), afterDay);
    return { error: `Say what time ${word}, for example "${word} 18:00".` };
  }
  return { error: 'Start with when to send it, for example: /later 30m run the tests · /later 14:30 … · /later tomorrow 9am … · /later next …' };
}

export interface WhenPreset {
  label: string;
  at: number;
}

/** The choices of the Send later menu. `busy`: a reply is being written, so "after it" is offered first. */
export function whenPresets(now: number, busy: boolean): WhenPreset[] {
  const base = new Date(now);
  const out: WhenPreset[] = [];
  if (busy) out.push({ label: 'When this reply is done', at: now });
  out.push({ label: 'In 30 minutes', at: now + 30 * MINUTE }, { label: 'In 1 hour', at: now + HOUR }, { label: 'In 3 hours', at: now + 3 * HOUR });
  // Late in the evening "this evening" is behind us; in the morning it is a useful choice.
  if (base.getHours() < 17) out.push({ label: 'This evening at 18:00', at: at(base, 18, 0) });
  out.push({ label: 'Tomorrow at 9:00', at: at(base, MORNING, 0, 1) });
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 14:05, always on the 24-hour clock so it reads the same everywhere. */
export function clockTime(time: number): string {
  const d = new Date(time);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "in 28 min" · "in 2 h 5 min" · "now" */
export function untilLabel(time: number, now: number): string {
  const ms = time - now;
  if (ms <= 0) return 'now';
  if (ms < MINUTE) return 'in less than a minute';
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `in ${hours} h ${minutes % 60} min` : `in ${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `in ${days} d ${hours % 24} h` : `in ${days} d`;
}

/** "today at 14:30" · "tomorrow at 09:00" · "Dec 1 at 14:30" */
export function whenLabel(time: number, now: number): string {
  const d = new Date(time);
  const n = new Date(now);
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / DAY);
  const day = dayDiff === 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : dayDiff === -1 ? 'yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} at ${clockTime(time)}`;
}

/** Value for `<input type="datetime-local">`: local time, to the minute. */
export function toLocalInput(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The time a `<input type="datetime-local">` holds, or undefined when it is empty or invalid. */
export function fromLocalInput(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return undefined;
  const time = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(time) ? time : undefined;
}
