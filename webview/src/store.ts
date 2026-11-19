import type { HostToWebview, ViewState, WebviewToHost } from '../../src/shared/protocol';
import { applyMessageEvent } from '../../src/shared/reducer';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
export const send = (message: WebviewToHost): void => vscode.postMessage(message);

const EMPTY: ViewState = {
  engine: 'opencode',
  engines: [],
  capabilities: { agents: false, fork: false, share: false, undo: false, compact: false, images: false, mcpToggle: false, permissions: false, providerAuth: false, remoteSessions: false },
  sessions: [],
  sessionId: undefined,
  messages: [],
  activity: 'idle',
  activityDetail: undefined,
  providers: [],
  model: undefined,
  agents: [],
  agent: undefined,
  commands: [],
  mcp: [],
  attachments: [],
  permissions: [],
  questions: [],
  sessionUsage: undefined,
  usage: undefined,
  avatar: { enabled: true, style: 'bot' },
  trusted: true,
  panel: { name: 'none', nonce: 0 },
  notice: undefined,
  loading: true,
};

type Listener = () => void;

/** Mirror of the host's view state plus a few webview-only signals. */
class Store {
  state: ViewState = EMPTY;
  /** Timestamp of the last streamed text chunk; drives the avatar's "speaking" mood. */
  lastDelta = 0;
  private listeners = new Set<Listener>();
  private fileWaiters = new Map<number, (files: { path: string; relative: string }[]) => void>();
  private requestId = 0;
  private hostListeners = new Set<(m: HostToWebview) => void>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  onHostMessage(l: (m: HostToWebview) => void): () => void {
    this.hostListeners.add(l);
    return () => this.hostListeners.delete(l);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  receive(msg: HostToWebview): void {
    switch (msg.type) {
      case 'state':
        this.state = msg.state;
        break;
      case 'patch':
        this.state = { ...this.state, ...msg.patch };
        break;
      case 'event': {
        if (!this.state.sessionId) return;
        if (msg.event.type === 'part.delta' || msg.event.type === 'part.updated') this.lastDelta = Date.now();
        const messages = applyMessageEvent(this.state.messages, msg.event, this.state.sessionId);
        if (messages === this.state.messages) return;
        this.state = { ...this.state, messages };
        break;
      }
      case 'fileResults': {
        this.fileWaiters.get(msg.requestId)?.(msg.files);
        this.fileWaiters.delete(msg.requestId);
        return;
      }
      case 'visible':
        window.dispatchEvent(new CustomEvent('ochub-visible', { detail: msg.visible }));
        return;
      default:
        for (const l of [...this.hostListeners]) l(msg);
        return;
    }
    this.emit();
  }

  searchFiles(query: string): Promise<{ path: string; relative: string }[]> {
    const requestId = ++this.requestId;
    return new Promise((resolve) => {
      this.fileWaiters.set(requestId, resolve);
      send({ type: 'searchFiles', requestId, query });
      setTimeout(() => {
        if (this.fileWaiters.delete(requestId)) resolve([]);
      }, 4000);
    });
  }
}

export const store = new Store();
window.addEventListener('message', (e: MessageEvent<HostToWebview>) => store.receive(e.data));
