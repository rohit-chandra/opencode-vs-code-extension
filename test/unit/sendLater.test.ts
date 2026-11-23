import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, clockTime, fromLocalInput, parseWhen, toLocalInput, untilLabel, whenLabel, whenPresets } from '../../src/shared/sendLater';

// A Monday, 10:15 local time.
const now = new Date(2026, 10, 23, 10, 15, 0, 0).getTime();
const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();
const ok = (input: string) => {
  const r = parseWhen(input, now);
  if ('error' in r) throw new Error(`${input}: ${r.error}`);
  return r;
};

describe('parseWhen', () => {
  it('reads a delay, with or without "in", in one or several units', () => {
    expect(ok('30m run the tests')).toEqual({ at: now + 30 * MINUTE, text: 'run the tests' });
    expect(ok('in 2 hours check the build')).toEqual({ at: now + 2 * HOUR, text: 'check the build' });
    expect(ok('1h30m go')).toEqual({ at: now + 90 * MINUTE, text: 'go' });
    expect(ok('1 h 30 min go')).toEqual({ at: now + 90 * MINUTE, text: 'go' });
    expect(ok('45 minutes   retry the deploy')).toEqual({ at: now + 45 * MINUTE, text: 'retry the deploy' });
    expect(ok('2d weekly summary')).toEqual({ at: now + 2 * DAY, text: 'weekly summary' });
    expect(ok('1.5h go')).toEqual({ at: now + 90 * MINUTE, text: 'go' });
    expect(ok('90s ping')).toEqual({ at: now + 90_000, text: 'ping' });
  });

  it('reads a time of day as the next time the clock shows it', () => {
    expect(ok('14:30 ship it')).toEqual({ at: local(2026, 11, 23, 14, 30), text: 'ship it' });
    // Already past today: tomorrow.
    expect(ok('9am stand-up notes')).toEqual({ at: local(2026, 11, 24, 9, 0), text: 'stand-up notes' });
    expect(ok('at 9:30pm wrap up')).toEqual({ at: local(2026, 11, 23, 21, 30), text: 'wrap up' });
    expect(ok('12am midnight job')).toEqual({ at: local(2026, 11, 24, 0, 0), text: 'midnight job' });
    expect(ok('12pm lunch')).toEqual({ at: local(2026, 11, 23, 12, 0), text: 'lunch' });
  });

  it('reads day words and dates', () => {
    expect(ok('tomorrow summarize the PRs')).toEqual({ at: local(2026, 11, 24, 9, 0), text: 'summarize the PRs' });
    expect(ok('tomorrow 8am go')).toEqual({ at: local(2026, 11, 24, 8, 0), text: 'go' });
    expect(ok('tomorrow at 17:45 go')).toEqual({ at: local(2026, 11, 24, 17, 45), text: 'go' });
    expect(ok('today 18:00 go')).toEqual({ at: local(2026, 11, 23, 18, 0), text: 'go' });
    expect(ok('2026-12-01 release notes')).toEqual({ at: local(2026, 12, 1, 9, 0), text: 'release notes' });
    expect(ok('2026-12-01 14:30 release notes')).toEqual({ at: local(2026, 12, 1, 14, 30), text: 'release notes' });
    expect(ok('2026-12-01T07:05 go')).toEqual({ at: local(2026, 12, 1, 7, 5), text: 'go' });
  });

  it('"next" and "when done" mean as soon as the chat is free', () => {
    expect(ok('next then commit')).toEqual({ at: now, text: 'then commit' });
    expect(ok('when done run lint')).toEqual({ at: now, text: 'run lint' });
    expect(ok('after this reply push')).toEqual({ at: now, text: 'push' });
  });

  it('does not take the start of an ordinary sentence for a time', () => {
    for (const text of ['5 files changed, look at them', 'minutes of the meeting', 'summarize this', '3 things to fix', 'nextjs upgrade', 'today is a good day']) {
      expect('error' in parseWhen(text, now), text).toBe(true);
    }
  });

  it('says what is wrong with a time it cannot use', () => {
    expect(parseWhen('today 9:00 too late', now)).toEqual({ error: 'That time has already passed.' });
    expect(parseWhen('300d far away', now)).toEqual({ error: 'That is more than 60 days away. Pick a time closer to now.' });
    expect(parseWhen('2020-01-01 long ago', now)).toEqual({ error: 'That time has already passed.' });
    expect(parseWhen('25:00 nope', now)).toEqual({ error: 'That is not a time I can read.' });
    expect(parseWhen('13pm nope', now)).toEqual({ error: 'That is not a time I can read.' });
    expect((parseWhen('today nope', now) as { error: string }).error).toMatch(/what time today/);
    expect((parseWhen('', now) as { error: string }).error).toMatch(/^Start with when to send it/);
  });

  it('the message may be empty (attachments only)', () => {
    expect(ok('30m')).toEqual({ at: now + 30 * MINUTE, text: '' });
  });
});

describe('send later labels and presets', () => {
  it('offers presets, and "when this reply is done" first while a reply is being written', () => {
    expect(whenPresets(now, false).map((p) => p.label)).toEqual(['In 30 minutes', 'In 1 hour', 'In 3 hours', 'This evening at 18:00', 'Tomorrow at 9:00']);
    const busy = whenPresets(now, true);
    expect(busy[0]).toEqual({ label: 'When this reply is done', at: now });
    expect(busy.at(-1)).toEqual({ label: 'Tomorrow at 9:00', at: local(2026, 11, 24, 9, 0) });
    // In the evening, "this evening" is gone.
    expect(whenPresets(local(2026, 11, 23, 19, 0), false).map((p) => p.label)).not.toContain('This evening at 18:00');
  });

  it('says how long until a time, and when it is', () => {
    expect(untilLabel(now, now)).toBe('now');
    expect(untilLabel(now - 5, now)).toBe('now');
    expect(untilLabel(now + 20_000, now)).toBe('in less than a minute');
    expect(untilLabel(now + 28 * MINUTE, now)).toBe('in 28 min');
    expect(untilLabel(now + 2 * HOUR, now)).toBe('in 2 h');
    expect(untilLabel(now + 2 * HOUR + 5 * MINUTE, now)).toBe('in 2 h 5 min');
    expect(untilLabel(now + 3 * DAY + 4 * HOUR, now)).toBe('in 3 d 4 h');
    expect(clockTime(local(2026, 11, 23, 9, 5))).toBe('09:05');
    expect(whenLabel(local(2026, 11, 23, 14, 30), now)).toBe('today at 14:30');
    expect(whenLabel(local(2026, 11, 24, 9, 0), now)).toBe('tomorrow at 09:00');
    expect(whenLabel(local(2026, 11, 22, 9, 0), now)).toBe('yesterday at 09:00');
    expect(whenLabel(local(2026, 12, 1, 9, 0), now)).toMatch(/ at 09:00$/);
  });

  it('round-trips the value of a date-and-time input', () => {
    expect(toLocalInput(local(2026, 12, 1, 7, 5))).toBe('2026-12-01T07:05');
    expect(fromLocalInput('2026-12-01T07:05')).toBe(local(2026, 12, 1, 7, 5));
    expect(fromLocalInput('')).toBeUndefined();
    expect(fromLocalInput('nonsense')).toBeUndefined();
  });
});
