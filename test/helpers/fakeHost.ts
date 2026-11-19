import type { HostToWebview, ViewState } from '../../src/shared/protocol';
import type { ControllerHost, PickItem } from '../../src/ui/controller';
import { applyMessageEvent } from '../../src/shared/reducer';
import { MemoryStore } from './context';
import type { TestContext } from './context';

/**
 * In-memory ControllerHost. It also plays the role of the webview: it applies the
 * messages the controller posts, so tests can assert on exactly what the UI would show.
 */
export class FakeHost implements ControllerHost {
  state = new MemoryStore();
  posted: HostToWebview[] = [];
  view: ViewState | undefined;
  infos: string[] = [];
  errors: string[] = [];
  saved: { name: string; content: string }[] = [];
  copied: string[] = [];
  terminals: { name: string; command: string }[] = [];
  opened: string[] = [];
  trusted = true;
  /** Queued answers for pick()/input()/confirm(), consumed in order. */
  picks: ((items: PickItem<unknown>[]) => unknown)[] = [];
  inputs: (string | undefined)[] = [];
  confirms: boolean[] = [];
  filesToPick: string[] = [];
  files: { path: string; relative: string }[] = [];

  constructor(private readonly ctx: TestContext) {}

  get log() {
    return this.ctx.log;
  }
  get secrets() {
    return this.ctx.secrets;
  }
  config = <T>(key: string, fallback: T): T => this.ctx.config(key, fallback);
  updateConfig = async (key: string, value: unknown): Promise<void> => {
    this.ctx.settings[key] = value;
  };
  workspaceTrusted = () => this.trusted;
  cwd = () => this.ctx.cwd();

  post(message: HostToWebview): void {
    this.posted.push(message);
    if (message.type === 'state') this.view = message.state;
    else if (message.type === 'patch' && this.view) this.view = { ...this.view, ...message.patch };
    else if ((message.type === 'event' || message.type === 'events') && this.view?.sessionId) {
      let messages = this.view.messages;
      for (const event of message.type === 'event' ? [message.event] : message.events) messages = applyMessageEvent(messages, event, this.view.sessionId);
      this.view = { ...this.view, messages };
    }
  }

  info(m: string): void {
    this.infos.push(m);
  }
  error(m: string): void {
    this.errors.push(m);
  }
  async pick<T>(items: PickItem<T>[]): Promise<T | undefined> {
    const next = this.picks.shift();
    return next ? (next(items as PickItem<unknown>[]) as T | undefined) : undefined;
  }
  async input(): Promise<string | undefined> {
    return this.inputs.shift();
  }
  async confirm(): Promise<boolean> {
    return this.confirms.shift() ?? true;
  }
  async pickFiles(): Promise<string[]> {
    return this.filesToPick;
  }
  async findFiles(query: string, limit: number) {
    return this.files.filter((f) => f.relative.includes(query)).slice(0, limit);
  }
  async openFile(file: string): Promise<void> {
    this.opened.push(file);
  }
  async openExternal(url: string): Promise<void> {
    this.opened.push(url);
  }
  async copy(text: string): Promise<void> {
    this.copied.push(text);
  }
  async insertIntoEditor(): Promise<void> {}
  async saveText(name: string, content: string): Promise<void> {
    this.saved.push({ name, content });
  }
  async openSettings(): Promise<void> {}
  runInTerminal(name: string, command: string): void {
    this.terminals.push({ name, command });
  }
  async focusView(): Promise<void> {}
  moved: string[] = [];
  async moveView(to: 'left' | 'right' | 'editor'): Promise<void> {
    this.moved.push(to);
  }
  environment() {
    return { extensionVersion: '9.9.9', editor: 'Test Editor 1.0.0', ui: 'desktop', platform: 'linux', arch: 'x64', osRelease: '6.0.0-test' };
  }
  repo: string | undefined = 'example/opencode-hub';
  repository() {
    return this.repo;
  }

  /** Wait until the mirrored view satisfies a predicate. */
  async until(pred: (v: ViewState) => boolean, timeoutMs = 60_000, what = 'condition'): Promise<ViewState> {
    const start = Date.now();
    for (;;) {
      if (this.view && pred(this.view)) return this.view;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}. activity=${this.view?.activity} messages=${this.view?.messages.length} notice=${this.view?.notice?.text}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  pickByLabel(pattern: RegExp): void {
    this.picks.push((items) => {
      const hit = items.find((i) => pattern.test(i.label));
      if (!hit) throw new Error(`No pick item matches ${pattern}: ${items.map((i) => i.label).join(' | ')}`);
      return hit.value;
    });
  }
}
