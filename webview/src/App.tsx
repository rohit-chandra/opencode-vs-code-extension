import { useEffect, useState } from 'preact/hooks';
import { ENGINE_LABELS } from '../../src/shared/types';
import { Avatar } from './components/Avatar';
import { Composer, droppedPaths } from './components/Composer';
import { MessageList } from './components/Messages';
import { McpPanel, ModelsPanel, SessionsPanel, UsagePanel } from './components/Panels';
import type { PanelName } from './components/Panels';
import { Requests } from './components/Requests';
import { compact, money, tokensIn, tokensOut } from './format';
import { deriveMood, useStore, useTick } from './hooks';
import { IconChart, IconChevron, IconClose, IconEye, IconHistory, IconPlug, IconPlus, IconWarn } from './icons';
import { send } from './store';

const SUGGESTIONS = [
  { label: 'Explain this workspace', text: 'Give me a short tour of this workspace: what it does and where the important code lives.' },
  { label: 'See every command', text: '/help' },
  { label: 'Check connected tools', text: '/mcp' },
];

export function App() {
  const s = useStore();
  const [panel, setPanel] = useState<PanelName>('none');
  const [toast, setToast] = useState<typeof s.notice>();
  const [dragging, setDragging] = useState(false);
  const busy = s.activity !== 'idle';
  // Moods such as "speaking" and "done" depend on elapsed time, so re-evaluate while they can change.
  useTick(busy || s.loading, 300);
  const [, settle] = useState(0);
  const { mood, caption } = deriveMood(s);
  useEffect(() => {
    if (mood === 'happy' || mood === 'error') {
      const id = setTimeout(() => settle((n) => n + 1), mood === 'happy' ? 1700 : 4100);
      return () => clearTimeout(id);
    }
  }, [mood, s.notice?.nonce, s.activity]);

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
  const sessionTokens = s.sessionUsage ? tokensIn(s.sessionUsage.usage) + tokensOut(s.sessionUsage.usage) : 0;
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
      class={`app ${empty ? 'is-empty' : 'has-messages'} ${s.avatar.enabled ? 'with-avatar' : 'no-avatar'}`}
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
          title={sessionTokens ? `This session: ${tokensIn(s.sessionUsage!.usage).toLocaleString()} tokens in, ${tokensOut(s.sessionUsage!.usage).toLocaleString()} out${s.sessionUsage!.usage.cost ? `, ${money(s.sessionUsage!.usage.cost)}` : ''}. Click for all usage.` : 'Token usage'}
          aria-label={`Token usage${sessionTokens ? `, ${sessionTokens.toLocaleString()} tokens in this session` : ''}`}
          onClick={() => toggle('usage')}
        >
          <IconChart />
          {sessionTokens > 0 && <span class="usage-count">{compact(sessionTokens)}</span>}
        </button>
        <button type="button" class="icon-btn" title={s.avatar.enabled ? 'Hide companion' : 'Show companion'} aria-label={s.avatar.enabled ? 'Hide companion' : 'Show companion'} aria-pressed={s.avatar.enabled} onClick={() => send({ type: 'setAvatar', enabled: !s.avatar.enabled })}>
          <IconEye />
        </button>
      </header>

      <div class="body">
        {s.avatar.enabled && (
          <div class="stage" data-mood={mood}>
            <button type="button" class="stage-oki" title="Click to switch between the robot and the orb" aria-label="Switch companion style" onClick={() => send({ type: 'setAvatar', style: s.avatar.style === 'bot' ? 'orb' : 'bot' })}>
              <Avatar mood={mood} style={s.avatar.style} />
            </button>
            <div class="stage-text">
              <div class="stage-caption" aria-live="polite">
                {caption}
              </div>
              {!empty && <div class="stage-sub">{[ENGINE_LABELS[s.engine], s.model?.modelId].filter(Boolean).join(', ')}</div>}
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
                        Add a provider
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
            ) : (
              <>
                <p class="welcome-line">
                  Chatting through {ENGINE_LABELS[s.engine]}
                  {s.model ? ` with ${s.model.modelId}` : ''}. Type <kbd>/</kbd> for commands or <kbd>@</kbd> to attach a file.
                </p>
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
          <MessageList messages={s.messages} busy={busy} />
        )}

        {!s.avatar.enabled && busy && (
          <div class="status-line" aria-live="polite">
            <span class="spinner" /> {caption}
          </div>
        )}

        {panel === 'sessions' && <SessionsPanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'models' && <ModelsPanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'mcp' && <McpPanel s={s} onClose={() => setPanel('none')} />}
        {panel === 'usage' && <UsagePanel s={s} onClose={() => setPanel('none')} />}

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
      <Composer s={s} onOpenPanel={(p) => setPanel(p)} />
    </div>
  );
}
