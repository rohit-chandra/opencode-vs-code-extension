export type Listener<T> = (value: T) => void;
export interface Disposable {
  dispose(): void;
}

/** Minimal typed event emitter so core code does not depend on the `vscode` module. */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (err) {
        console.error('[opencode-hub] listener failed', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
