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
  otherSessions: [],
  sessionId: undefined,
  messages: [],
  activity: 'idle',
  activityDetail: undefined,
  providers: [],
  model: undefined,
  effort: undefined,
  agents: [],
  agent: undefined,
  commands: [],
  mcp: [],
  attachments: [],
  permissions: [],
  questions: [],
  sessionUsage: undefined,
  usage: undefined,
  avatar: { enabled: true, style: 'buddy' },
  zoom: 1,
  providerColors: true,
  activeFile: undefined,
  trusted: true,
  canRetry: false,
  recentModels: [],
  auth: undefined,
  approvals: 'ask',
  panel: { name: 'none', nonce: 0 },
  diagnostics: '',
  feedbackDraft: undefined,
  notice: undefined,
  loading: true,
};

type Listener = () => void;

/** Mirror of the host's view state plus a few webview-only signals. */
class Store {
  state: ViewState = EMPTY;
  /** Timestamp of the last streamed text chunk; drives the avatar's "speaking" mood. */
  lastDelta = 0;
  /** Last keystroke in the message box; drives the "listening" mood. */
  typingAt = 0;
  /** Last pointer or keyboard activity anywhere in the view; Oki dozes off without any. */
  lastInteraction = Date.now();
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

  private scheduled = false;
  /**
   * Notify subscribers at most once per animation frame. A fast model can deliver dozens of
   * chunks between two frames; rendering each one separately would only burn CPU.
   */
  private emit(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const flush = () => {
      this.scheduled = false;
      for (const l of [...this.listeners]) l();
    };
    if (document.hidden) setTimeout(flush, 0);
    else requestAnimationFrame(flush);
  }

  /** Mark the user as typing (throttled re-render so the companion can react). */
  typing(): void {
    const now = Date.now();
    const wasTyping = now - this.typingAt < 1600;
    this.typingAt = now;
    this.lastInteraction = now;
    if (!wasTyping) this.emit();
  }

  receive(msg: HostToWebview): void {
    switch (msg.type) {
      case 'state':
        this.state = msg.state;
        break;
      case 'patch': {
        // The host sends cleared fields as null (JSON drops undefined): clear them here.
        const patch: Record<string, unknown> = { ...msg.patch };
        for (const k of Object.keys(patch)) if (patch[k] === null) patch[k] = undefined;
        this.state = { ...this.state, ...(patch as Partial<ViewState>) };
        break;
      }
      case 'event':
      case 'events': {
        if (!this.state.sessionId) return;
        let messages = this.state.messages;
        for (const event of msg.type === 'event' ? [msg.event] : msg.events) {
          if (event.type === 'part.delta' || event.type === 'part.updated') this.lastDelta = Date.now();
          messages = applyMessageEvent(messages, event, this.state.sessionId);
        }
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
for (const type of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(type, () => (store.lastInteraction = Date.now()), { passive: true });
