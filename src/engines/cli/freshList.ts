/**
 * A list that is expensive to fetch (it starts a CLI) and can change behind our back:
 * the models an account may use. Claude Code and Codex learn an account's plan from their
 * servers, sometimes only after the first request following a sign-in, so a list fetched
 * right after signing in can be the generic one. Caching that for minutes is how a model
 * picker ends up with models missing.
 *
 * So: the first read waits for the fetch. Later reads return what is known at once and,
 * when it is older than `revalidateMs`, fetch again in the background; `onChange` fires only
 * when the fresh list differs. An empty result (the CLI could not answer) is retried sooner.
 */
export class FreshList<T> {
  private value: { at: number; key: string; data: T } | undefined;
  private inFlight: { key: string; promise: Promise<T> } | undefined;
  private generation = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly opts: {
      isEmpty: (data: T) => boolean;
      /** Called after a background refresh found a different list. */
      onChange: () => void;
      /** Age after which a read triggers a background refresh. */
      revalidateMs?: number;
      /** Age after which an empty result is fetched again (the read waits for it). */
      emptyRetryMs?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Forget the list (the account changed). The next read fetches it. */
  invalidate(): void {
    this.value = undefined;
    this.generation++;
  }

  /** Age of the cached list in milliseconds, or undefined when there is none. */
  age(): number | undefined {
    return this.value ? this.now() - this.value.at : undefined;
  }

  /** The list for `key` (the sign-in mode). Fetches when there is none, refreshes in the background when stale. */
  async get(key: string): Promise<T> {
    const v = this.value;
    if (v && v.key === key) {
      const age = this.now() - v.at;
      if (this.opts.isEmpty(v.data)) {
        if (age <= (this.opts.emptyRetryMs ?? 15_000)) return v.data;
      } else {
        if (age > (this.opts.revalidateMs ?? 60_000)) this.refresh(key);
        return v.data;
      }
    }
    return this.fetch(key);
  }

  /** Fetch again in the background when the list is older than `olderThanMs`; `onChange` fires if it differs. */
  refresh(key: string, olderThanMs = 0): void {
    const v = this.value;
    if (!v || v.key !== key) return;
    if (this.now() - v.at < olderThanMs || this.inFlight) return;
    const before = JSON.stringify(v.data);
    void this.fetch(key).then(
      (data) => {
        if (this.value?.key === key && this.value.data === data && JSON.stringify(data) !== before) this.opts.onChange();
      },
      () => undefined,
    );
  }

  private fetch(key: string): Promise<T> {
    if (this.inFlight?.key === key) return this.inFlight.promise;
    const generation = this.generation;
    const promise = this.load()
      .then((data) => {
        // A failed refresh must not replace a list we already have with nothing.
        const keep = this.value?.key === key && this.opts.isEmpty(data) && !this.opts.isEmpty(this.value.data);
        if (generation === this.generation && !keep) this.value = { at: this.now(), key, data };
        else if (generation === this.generation && keep) this.value = { ...this.value!, at: this.now() };
        return generation === this.generation && keep ? this.value!.data : data;
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = undefined;
      });
    this.inFlight = { key, promise };
    return promise;
  }
}
