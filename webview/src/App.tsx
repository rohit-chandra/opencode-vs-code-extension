import { useEffect, useState } from 'preact/hooks';
import { providerBrand } from '../../src/shared/providerColors';
import { ENGINE_LABELS } from '../../src/shared/types';
import { Avatar } from './components/Avatar';
import { Composer, droppedPaths } from './components/Composer';
import { MessageList } from './components/Messages';
import { FeedbackPanel, McpPanel, ModelsPanel, SessionsPanel, UsagePanel } from './components/Panels';
import type { PanelName } from './components/Panels';
import { Requests } from './components/Requests';
import { Scheduled } from './components/Scheduled';
import { money, tokensAll, usageDetail } from './format';
import { deriveMood, moodDeadline, useStore, useTick } from './hooks';
import { IconChart, IconChevron, IconClose, IconEye, IconHistory, IconKey, IconPlug, IconPlus, IconRefresh, IconUser, IconWarn } from './icons';
import type { ViewState } from '../../src/shared/protocol';
import { setPreviews } from './markdown';
import { send } from './store';

const SUGGESTIONS = [
  { label: 'Explain this workspace', text: 'Give me a short tour of this workspace: what it does and where the important code lives.' },
  { label: 'See every command', text: '/help' },
  { label: 'Check connected tools', text: '/mcp' },
];

const ACCOUNT: Partial<Record<ViewState['engine'], { name: string; plan: string; vendor: string }>> = {
  'claude-code': { name: 'Claude', plan: 'Claude Pro or Max plan', vendor: 'Anthropic' },
  codex: { name: 'ChatGPT', plan: 'ChatGPT Plus or Pro plan', vendor: 'OpenAI' },
};

/** Whether the active engine needs the user to sign in (or fix how it is billed) before chatting. */
function needsAccount(s: ViewState): boolean {
  const a = s.auth;
  if (!a || !ACCOUNT[s.engine]) return false;
  if (a.pending) return true;
  if (a.signedIn === false) return true;
  return a.mode === 'subscription' && a.signedIn === true && a.billing === 'apiKey';
}

/** Sign-in prompt for Claude Code and Codex: the account (subscription) first, an API key as the alternative. */
function AccountPrompt({ s, bar }: { s: ViewState; bar?: boolean }) {
  const a = s.auth!;
  const acc = ACCOUNT[s.engine]!;
  const label = ENGINE_LABELS[s.engine];
  const apiKeyMode = a.mode === 'apiKey';
  const billingKey = a.mode === 'subscription' && a.signedIn === true && a.billing === 'apiKey';
  const title = a.pending ? `Waiting for your ${acc.name} sign-in…` : apiKeyMode ? `Add an API key for ${label}` : billingKey ? `${label} is using an API key` : `Sign in to ${label} with your ${acc.name} account`;
  const text = a.pending
    ? 'Finish signing in in the browser window that opened (the terminal shows the link if it did not). This updates by itself.'
    : apiKeyMode
      ? `${label} is set to use an API key, billed per token by ${acc.vendor}. Signing in with your ${acc.name} account uses your ${acc.plan} instead.`
      : billingKey
        ? `${a.label ? `${a.label}. ` : ''}That is billed per token. Sign in with your ${acc.name} account to use your ${acc.plan} instead.`
        : `Uses your ${acc.plan}: no API key and no per-token charges.`;
  return (
    <div class={`callout account ${bar ? 'auth-bar' : ''} ${a.pending ? 'pending' : ''}`} role="region" aria-label="Account">
      {a.pending ? <span class="spinner" /> : <IconUser size={15} />}
      <div>
        <p class="callout-title">{title}</p>
        <p>{text}</p>
        <div class="callout-actions">
          {apiKeyMode ? (
            <>
              <button type="button" class="btn primary" onClick={() => send({ type: 'useApiKey' })}>
                <IconKey size={12} /> Add API key
              </button>
              <button type="button" class="btn" onClick={() => send({ type: 'signIn' })}>
                Sign in with {acc.name} instead
              </button>
            </>
          ) : (
            <>
              <button type="button" class={`btn ${a.pending ? '' : 'primary'}`} onClick={() => send({ type: 'signIn' })}>
                {a.pending ? 'Open sign-in again' : `Sign in with ${acc.name}`}
              </button>
              {s.engine === 'codex' && (
                <button type="button" class="btn quiet" title="For remote, SSH, WSL or container setups" onClick={() => send({ type: 'signIn', deviceCode: true })}>
                  Use a device code
                </button>
              )}
              <button type="button" class="btn quiet" onClick={() => send({ type: 'useApiKey' })}>
                Use an API key instead
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const s = useStore();
  const [panel, setPanel] = useState<PanelName>('none');
  const [toast, setToast] = useState<typeof s.notice>();
  const [dragging, setDragging] = useState(false);
  const busy = s.activity !== 'idle';
  // Moods such as "speaking" depend on elapsed time, so re-evaluate while they can change.
  useTick(busy || s.loading, 300);
  const [, settle] = useState(0);
  const [poke, setPoke] = useState(0);
  const { mood, caption, work } = deriveMood(s);
  // Timed moods (celebrating, listening, dozing off) end on their own: re-render exactly then.
  useEffect(() => {
    const wait = moodDeadline() ?? (mood === 'idle' ? 60_000 : undefined);
    if (wait === undefined) return;
    const id = setTimeout(() => settle((n) => n + 1), wait + 30);
    return () => clearTimeout(id);
  });
  useEffect(() => {
    document.documentElement.style.setProperty('--oh-zoom', String(s.zoom || 1));
  }, [s.zoom]);
  // Applies to replies drawn from now on; what is on screen keeps its form.
  setPreviews(s.htmlPreview !== false);
  // The frame takes the colour of the model's maker, so the provider is visible at a glance.
  const brand = s.providerColors ? providerBrand(s.engine, s.model) : undefined;
  useEffect(() => {
    const root = document.documentElement;
    if (brand) root.style.setProperty('--oh-provider', brand.color);
    else root.style.removeProperty('--oh-provider');
  }, [brand?.color]);

  useEffect(() => {
    if (s.panel.nonce) setPanel(s.panel.name);
  }, [s.panel.nonce]);
  useEffect(() => {
    if (!s.notice) return;
    setToast(s.notice);
    const id = setTimeout(() => setToast(undefined), s.notice.level === 'error' ? 9000 : 4000);
    return () => clearTimeout(id);
  }, [s.notice?.nonce]);

  const engine = s.engines.find((e) => e.engine === s.engine);
  const session = s.sessions.find((x) => x.id === s.sessionId);
  const empty = s.messages.length === 0;
  const mcpOn = s.mcp.filter((m) => m.status === 'connected').length;
  const mcpBad = s.mcp.some((m) => m.status === 'failed' || m.status === 'needs_auth');
  const sessionTokens = s.sessionUsage ? tokensAll(s.sessionUsage.usage) : 0;
  const toggle = (name: PanelName) => setPanel((p) => (p === name ? 'none' : name));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const paths = droppedPaths(dt);
    if (paths.length) return send({ type: 'addPaths', paths });
    // Files dragged from outside VS Code have no path the extension can read, so send their content.
    for (const file of [...dt.files]) {
      if (file.size > 5 * 1024 * 1024) continue;
      const reader = new FileReader();
      const image = file.type.startsWith('image/');
      reader.onload = () => send({ type: 'addAttachment', attachment: image ? { id: '', kind: 'image', name: file.name, mime: file.type, dataUrl: String(reader.result) } : { id: '', kind: 'file', name: file.name, mime: 'text/plain', text: String(reader.result) } });
      if (image) reader.readAsDataURL(file);
      else reader.readAsText(file);
    }
  };

  return (
    <div
      class={`app ${empty ? 'is-empty' : 'has-messages'} ${s.avatar.enabled ? 'with-avatar' : 'no-avatar'} ${brand ? 'branded' : ''}`}
      data-provider={brand?.id}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header class="topbar">
        <button type="button" class="session-btn" title="Switch session" aria-haspopup="dialog" onClick={() => toggle('sessions')}>
          <span class="session-title">{session?.title ?? 'New session'}</span>
          <IconChevron size={12} />
        </button>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="New session" aria-label="New session" onClick={() => (setPanel('none'), send({ type: 'newSession' }))}>
          <IconPlus />
        </button>
        <button type="button" class={`icon-btn ${panel === 'sessions' ? 'on' : ''}`} title="Sessions" aria-label="Sessions" onClick={() => toggle('sessions')}>
          <IconHistory />
        </button>
        <button type="button" class={`icon-btn mcp-btn ${panel === 'mcp' ? 'on' : ''}`} title={`MCP servers: ${mcpOn} of ${s.mcp.length} connected${mcpBad ? ', some need attention' : ''}`} aria-label={`MCP servers, ${mcpOn} of ${s.mcp.length} connected`} onClick={() => (send({ type: 'mcpRefresh' }), toggle('mcp'))}>
          <IconPlug />
          {s.mcp.length > 0 && <span class={`badge ${mcpOn ? 'ok' : ''}`}>{mcpOn}</span>}
          {mcpBad && <span class="alert-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          class={`icon-btn usage-btn ${panel === 'usage' ? 'on' : ''}`}
          title={sessionTokens ? `This session: ${usageDetail(s.sessionUsage!.usage)}${s.sessionUsage!.usage.cost ? `, ${money(s.sessionUsage!.usage.cost)}` : ''}. Click for all usage.` : 'Token usage'}
          aria-label={`Token usage${sessionTokens ? `, ${sessionTokens.toLocaleString()} tokens in this session` : ''}`}
          onClick={() => toggle('usage')}
        >
          <IconChart />
        </button>
        <button type="button" class="icon-btn" title={s.avatar.enabled ? 'Hide companion' : 'Show companion'} aria-label={s.avatar.enabled ? 'Hide companion' : 'Show companion'} aria-pressed={s.avatar.enabled} onClick={() => send({ type: 'setAvatar', enabled: !s.avatar.enabled })}>
          <IconEye />
        </button>
      </header>

      <div class="body">
        {s.avatar.enabled && (
          <div class="stage" data-mood={mood}>
            <button type="button" class="stage-oki" title="Say hi" aria-label="Poke the companion" onClick={() => setPoke((n) => n + 1)}>
              <Avatar mood={mood} work={work} style={s.avatar.style} poke={poke} />
            </button>
            <button type="button" class="icon-btn stage-swap" title={s.avatar.style === 'buddy' ? 'Switch to dots' : 'Switch to Oki'} aria-label="Switch companion style" onClick={() => send({ type: 'setAvatar', style: s.avatar.style === 'buddy' ? 'dots' : 'buddy' })}>
              <IconRefresh size={12} />
            </button>
            <div class="stage-text">
              <div class="stage-caption" aria-live="polite">
                {caption}
              </div>
              {!empty && (
                <div class="stage-sub">
                  {brand && <span class="brand-dot" title={brand.label} aria-label={brand.label} />}
                  {[ENGINE_LABELS[s.engine], s.model?.modelId].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          </div>
        )}

        {empty ? (
          <div class="welcome">
            {!s.avatar.enabled && <h1>What are we building?</h1>}
            {engine?.state === 'unavailable' ? (
              <div class="callout" role="alert">
                <IconWarn size={15} />
                <div>
                  <p class="callout-title">{ENGINE_LABELS[s.engine]} is not available</p>
                  <p>{engine.detail}</p>
                  <div class="callout-actions">
                    <button type="button" class="btn primary" onClick={() => send({ type: 'restartEngine' })}>
                      Try again
                    </button>
                    {(s.engine === 'direct' || s.engine === 'opencode') && (
                      <button type="button" class="btn" onClick={() => send({ type: 'manageProviders' })}>
                        Sign in or add a provider
                      </button>
                    )}
                    <button type="button" class="btn quiet" onClick={() => send({ type: 'send', text: '/engine' })}>
                      Switch engine
                    </button>
                  </div>
                </div>
              </div>
            ) : !s.trusted ? (
              <div class="callout" role="alert">
                <IconWarn size={15} />
                <div>
                  <p class="callout-title">Workspace not trusted</p>
                  <p>Agents can read files and run tools here, so chat stays off until you trust this workspace.</p>
                </div>
              </div>
            ) : needsAccount(s) ? (
              <AccountPrompt s={s} />
            ) : (
              <>
                <p class="welcome-line">
                  Chatting through {ENGINE_LABELS[s.engine]}
                  {s.model ? ` with ${s.model.modelId}` : ''}. Type <kbd>/</kbd> for commands or <kbd>@</kbd> to attach a file.
                </p>
                {s.auth?.signedIn && (
                  <button type="button" class="account-chip" title="Sign-in options" onClick={() => send({ type: 'accountMenu' })}>
                    {s.auth.billing === 'apiKey' ? <IconKey size={12} /> : <IconUser size={12} />}
                    <span>{s.auth.label ?? 'Signed in'}</span>
                    <span class="account-change">Change</span>
                  </button>
                )}
                <div class="suggestions">
                  {SUGGESTIONS.map((x) => (
                    <button type="button" class="suggestion" key={x.label} onClick={() => send({ type: 'send', text: x.text })}>
                      {x.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <MessageList messages={s.messages} busy={busy} canRetry={s.canRetry} />
        )}

        {!empty && needsAccount(s) && <AccountPrompt s={s} bar />}

        {!s.avatar.enabled && busy && (
          <div class="status-line" aria-live="polite">
            <span class="spinner" /> {caption}
          </div>
        )}

        {panel === 'sessions' && <SessionsPanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'models' && <ModelsPanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'mcp' && <McpPanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'usage' && <UsagePanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'feedback' && <FeedbackPanel key={s.panel.nonce} s={s} onClose={() => setPanel('none')} />}

        {toast && (
          <div class={`toast ${toast.level}`} role={toast.level === 'error' ? 'alert' : 'status'}>
            <span>{toast.text}</span>
            <button type="button" class="icon-btn" aria-label="Dismiss" onClick={() => setToast(undefined)}>
              <IconClose size={12} />
            </button>
          </div>
        )}
        {dragging && <div class="drop-hint">Drop to attach (hold Shift when dragging from the Explorer)</div>}
      </div>

      <Requests permissions={s.permissions} questions={s.questions} />
      <Scheduled s={s} />
      <Composer s={s} onOpenPanel={(p) => setPanel(p)} />
    </div>
  );
}
