import { describe, expect, it } from 'vitest';
import { FreshList } from '../../src/engines/cli/freshList';

function setup(initial: string[]) {
  const s = { now: 0, data: initial, loads: 0, changes: 0, fail: false };
  const list = new FreshList<string[]>(
    async () => {
      s.loads++;
      if (s.fail) throw new Error('cli failed');
      return [...s.data];
    },
    { isEmpty: (d) => d.length === 0, onChange: () => s.changes++, now: () => s.now, revalidateMs: 60_000, emptyRetryMs: 15_000 },
  );
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { s, list, settle };
}

describe('FreshList (the model list of an account)', () => {
  it('fetches once, then answers from memory while the list is fresh', async () => {
    const { s, list } = setup(['sonnet', 'haiku']);
    expect(await list.get('subscription')).toEqual(['sonnet', 'haiku']);
    s.now = 59_000;
    expect(await list.get('subscription')).toEqual(['sonnet', 'haiku']);
    expect(s.loads).toBe(1);
    expect(list.age()).toBe(59_000);
  });

  it('answers at once from a stale list, refreshes it in the background and reports a change once', async () => {
    const { s, list, settle } = setup(['sonnet', 'haiku']);
    await list.get('subscription');
    // The CLI has learnt the plan since: more models.
    s.data = ['opus', 'fable', 'sonnet', 'haiku'];
    s.now = 61_000;
    expect(await list.get('subscription')).toEqual(['sonnet', 'haiku']);
    await settle();
    expect(s.changes).toBe(1);
    expect(await list.get('subscription')).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    // Stale again but unchanged: refreshed quietly.
    s.now = 200_000;
    await list.get('subscription');
    await settle();
    expect(s.changes).toBe(1);
    expect(s.loads).toBe(3);
  });

  it('fetches again when the account changes', async () => {
    const { s, list } = setup(['sonnet']);
    await list.get('subscription');
    s.data = ['opus'];
    list.invalidate();
    expect(list.age()).toBeUndefined();
    expect(await list.get('subscription')).toEqual(['opus']);
    // Another sign-in mode is another list.
    s.data = ['api-model'];
    expect(await list.get('apiKey')).toEqual(['api-model']);
    expect(s.loads).toBe(3);
  });

  it('retries soon after the CLI could not answer, and never swaps a known list for an empty one', async () => {
    const { s, list, settle } = setup([]);
    expect(await list.get('subscription')).toEqual([]);
    s.now = 10_000;
    expect(await list.get('subscription')).toEqual([]);
    expect(s.loads).toBe(1);
    s.data = ['sonnet'];
    s.now = 16_000;
    expect(await list.get('subscription')).toEqual(['sonnet']);
    expect(s.loads).toBe(2);

    // A later refresh comes back empty (the CLI timed out): keep what we have.
    s.data = [];
    s.now = 100_000;
    expect(await list.get('subscription')).toEqual(['sonnet']);
    await settle();
    expect(await list.get('subscription')).toEqual(['sonnet']);
    expect(s.changes).toBe(0);
    // A refresh that throws does not break later reads either.
    s.fail = true;
    s.now = 200_000;
    expect(await list.get('subscription')).toEqual(['sonnet']);
    await settle();
    s.fail = false;
    s.data = ['sonnet', 'opus'];
    s.now = 300_000;
    await list.get('subscription');
    await settle();
    expect(await list.get('subscription')).toEqual(['sonnet', 'opus']);
    expect(s.changes).toBe(1);
  });

  it('refresh(key, olderThan) skips a list that is new enough, and shares one fetch between callers', async () => {
    const { s, list, settle } = setup(['sonnet']);
    const [a, b] = await Promise.all([list.get('subscription'), list.get('subscription')]);
    expect(a).toEqual(b);
    expect(s.loads).toBe(1);
    s.data = ['sonnet', 'opus'];
    s.now = 5_000;
    list.refresh('subscription', 20_000);
    await settle();
    expect(s.loads).toBe(1);
    s.now = 25_000;
    list.refresh('subscription', 20_000);
    await settle();
    expect(s.loads).toBe(2);
    expect(s.changes).toBe(1);
  });
});
