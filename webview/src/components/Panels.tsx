import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ViewState } from '../../../src/shared/protocol';
import { FEEDBACK_KINDS } from '../../../src/shared/feedback';
import type { FeedbackKind } from '../../../src/shared/feedback';
import { ENGINE_LABELS } from '../../../src/shared/types';
import type { McpServerInfo, TokenUsage, UsageRow } from '../../../src/shared/types';
import { compact, dayLabel, money, relativeTime, tokensAll, tokensIn, tokensOut } from '../format';
import { IconCheck, IconClose, IconLink, IconPencil, IconPlus, IconRefresh, IconSearch, IconTrash } from '../icons';
import { send } from '../store';

export type PanelName = 'none' | 'sessions' | 'mcp' | 'usage' | 'models' | 'feedback';

function Sheet({ title, onClose, actions, children }: { title: string; onClose: () => void; actions?: ComponentChildren; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, button.sheet-focus')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="sheet" ref={ref} role="dialog" aria-label={title}>
      <div class="sheet-head">
        <h2>{title}</h2>
        <span class="spacer" />
        {actions}
        <button type="button" class="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div class="sheet-body">{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- sessions */

export function SessionsPanel({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<'all' | 'engine'>('all');
  useEffect(() => send({ type: 'sessionsRefresh' }), []);
  const usage = useMemo(() => new Map((s.usage?.sessions ?? []).map((u) => [`${u.engine}|${u.sessionId}`, u])), [s.usage]);
  const q = query.trim().toLowerCase();
  const all = scope === 'all' ? [...s.sessions, ...(s.otherSessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt) : s.sessions;
  const sessions = all.filter((x) => !q || x.title.toLowerCase().includes(q) || (scope === 'all' && ENGINE_LABELS[x.engine].toLowerCase().includes(q)));
  const otherCount = s.otherSessions?.length ?? 0;
  const committed = useRef(false);
  // Enter commits and unmounts the input, which then also fires blur: only send once.
  const commit = (id: string) => {
    if (committed.current) return;
    committed.current = true;
    const title = draft.trim();
    if (title && title !== s.sessions.find((x) => x.id === id)?.title) send({ type: 'renameSession', sessionId: id, title });
    setEditing(undefined);
  };
  return (
    <Sheet
      title="Sessions"
      onClose={onClose}
      actions={
        <button type="button" class="btn small" onClick={() => (send({ type: 'newSession' }), onClose())}>
          <IconPlus size={12} /> New
        </button>
      }
    >
      <div class="segmented" role="tablist" aria-label="Which sessions">
        <button type="button" role="tab" aria-selected={scope === 'all'} class={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
          All engines
        </button>
        <button type="button" role="tab" aria-selected={scope === 'engine'} class={scope === 'engine' ? 'on' : ''} onClick={() => setScope('engine')}>
          {ENGINE_LABELS[s.engine]}
        </button>
      </div>
      <label class="search">
        <IconSearch size={13} />
        <input type="text" placeholder={scope === 'all' ? 'Search sessions' : `Search ${ENGINE_LABELS[s.engine]} sessions`} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      {sessions.length === 0 && <p class="empty-note">{all.length ? 'No session matches.' : scope === 'engine' && otherCount ? `No ${ENGINE_LABELS[s.engine]} sessions yet. ${otherCount} from other engines under All engines.` : 'No sessions yet. Send a message to start one.'}</p>}
      <ul class="list">
        {sessions.map((x) => {
          const u = usage.get(`${x.engine}|${x.id}`);
          const here = x.engine === s.engine;
          return (
            <li key={`${x.engine}|${x.id}`} class={`row session ${x.id === s.sessionId ? 'active' : ''}`}>
              {editing === x.id ? (
                <input
                  class="rename"
                  value={draft}
                  aria-label="Session title"
                  ref={(el) => {
                    el?.focus();
                  }}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(x.id);
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      committed.current = true;
                      setEditing(undefined);
                    }
                  }}
                  onBlur={() => commit(x.id)}
                />
              ) : (
                <button type="button" class="row-main" title={here ? undefined : `Opens in ${ENGINE_LABELS[x.engine]}`} onClick={() => (send(here ? { type: 'switchSession', sessionId: x.id } : { type: 'switchSession', sessionId: x.id, engine: x.engine }), onClose())}>
                  <span class="row-title">{x.title}</span>
                  <span class="row-sub">
                    {scope === 'all' && <span class={`engine-tag ${here ? 'here' : ''}`}>{ENGINE_LABELS[x.engine]}</span>}
                    {relativeTime(x.updatedAt)}
                    {u ? `, ${compact(tokensAll(u.usage))} tokens${u.usage.cost ? `, ${money(u.usage.cost)}` : ''}` : ''}
                  </span>
                </button>
              )}
              <span class="row-actions">
                {!(here && x.id === s.sessionId) && (
                  <button type="button" class="icon-btn" title="Use as context: attach a condensed copy to your next message" aria-label={`Use ${x.title} as context`} onClick={() => (send({ type: 'attachSession', sessionId: x.id, engine: x.engine }), onClose())}>
                    <IconLink size={13} />
                  </button>
                )}
                {here && (
                  <button type="button" class="icon-btn" title="Rename" aria-label={`Rename ${x.title}`} onClick={() => {
                      committed.current = false;
                      setDraft(x.title);
                      setEditing(x.id);
                    }}>
                    <IconPencil size={13} />
                  </button>
                )}
                <button type="button" class="icon-btn" title="Delete" aria-label={`Delete ${x.title}`} onClick={() => send(here ? { type: 'deleteSession', sessionId: x.id } : { type: 'deleteSession', sessionId: x.id, engine: x.engine })}>
                  <IconTrash size={13} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ models */

const MAX_MODEL_ROWS = 150;

export function ModelsPanel({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Some engines offer thousands of models; render a bounded list and let search narrow it down.
  let room = MAX_MODEL_ROWS;
  let hidden = 0;
  const groups = s.providers
    .map((p) => {
      const matches = p.models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      const shown = matches.slice(0, Math.max(0, room));
      room -= shown.length;
      hidden += matches.length - shown.length;
      return { ...p, models: shown };
    })
    .filter((p) => p.models.length > 0);
  const recent = s.recentModels.flatMap((ref) => {
    const provider = s.providers.find((p) => p.id === ref.providerId);
    const model = provider?.models.find((m) => m.modelId === ref.modelId);
    return provider && model ? [{ ...model, provider: provider.name }] : [];
  });
  return (
    <Sheet
      title="Model"
      onClose={onClose}
      actions={
        <button type="button" class="btn small" onClick={() => send({ type: 'manageProviders' })}>
          Connect provider
        </button>
      }
    >
      <label class="search">
        <IconSearch size={13} />
        <input type="text" placeholder="Search models" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      {!q && recent.length > 1 && (
        <section class="group recent">
          <h3>Recent</h3>
          <ul class="list">
            {recent.map((m) => {
              const active = s.model?.providerId === m.providerId && s.model?.modelId === m.modelId;
              return (
                <li key={`${m.providerId}/${m.modelId}`} class={`row ${active ? 'active' : ''}`}>
                  <button type="button" class="row-main" onClick={() => (send({ type: 'setModel', model: { providerId: m.providerId, modelId: m.modelId } }), onClose())}>
                    <span class="row-title">{m.name}</span>
                    <span class="row-sub">{m.provider}</span>
                  </button>
                  {active && <IconCheck size={14} class="row-check" />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {groups.length === 0 && <p class="empty-note">{s.providers.length ? 'No model matches.' : s.loading ? 'Loading models…' : 'No models yet. Connect a provider to see its models here.'}</p>}
      {groups.map((p) => (
        <section key={p.id} class="group">
          <h3>{p.name}</h3>
          <ul class="list">
            {p.models.map((m) => {
              const active = s.model?.providerId === m.providerId && s.model?.modelId === m.modelId;
              return (
                <li key={m.modelId} class={`row ${active ? 'active' : ''}`}>
                  <button type="button" class="row-main" onClick={() => (send({ type: 'setModel', model: { providerId: m.providerId, modelId: m.modelId } }), onClose())}>
                    <span class="row-title">{m.name}</span>
                    <span class="row-sub" title={[m.resolvedId ?? m.modelId, m.description].filter(Boolean).join(' · ')}>
                      {[m.modelId !== m.name ? m.modelId : '', m.contextWindow ? `${compact(m.contextWindow)} context` : '', m.description ?? ''].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  {active && <IconCheck size={14} class="row-check" />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {hidden > 0 && <p class="sheet-foot">{hidden} more not shown. Type to search.</p>}
      {(s.engine === 'claude-code' || s.engine === 'codex') && (
        <div class="sheet-foot add-model">
          <span>This is the list {s.engine === 'claude-code' ? 'Claude Code' : 'Codex'} reports for your account. Missing one, such as an earlier version?</span>
          <button type="button" class="btn small" onClick={() => (send({ type: 'addModel' }), onClose())}>
            Add a model by name…
          </button>
        </div>
      )}
    </Sheet>
  );
}

/* --------------------------------------------------------------------- mcp */

const MCP_STATUS: Record<McpServerInfo['status'], string> = { connected: 'Connected', disabled: 'Off', failed: 'Failed', needs_auth: 'Needs sign-in', connecting: 'Connecting…' };

const MCP_HELP: Record<string, string> = {
  opencode: 'Add servers under "mcp" in opencode.json (project or ~/.config/opencode).',
  direct: 'Add servers under "opencodeHub.mcp.servers" in your VS Code settings.',
  'vscode-lm': 'Add servers under "opencodeHub.mcp.servers" in your VS Code settings.',
  'claude-code': 'Add servers to .mcp.json in the workspace, or run `claude mcp add`.',
  codex: 'Add servers under [mcp_servers] in ~/.codex/config.toml, or run `codex mcp add`.',
};

export function McpPanel({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const on = s.mcp.filter((m) => m.status === 'connected').length;
  return (
    <Sheet
      title="MCP servers"
      onClose={onClose}
      actions={
        <button type="button" class="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => send({ type: 'mcpRefresh' })}>
          <IconRefresh size={14} />
        </button>
      }
    >
      <p class="sheet-lede">
        {s.mcp.length ? `${on} of ${s.mcp.length} connected for ${ENGINE_LABELS[s.engine]}.` : `No MCP servers configured for ${ENGINE_LABELS[s.engine]}.`} {s.mcp.length === 0 && MCP_HELP[s.engine]}
      </p>
      <ul class="list">
        {s.mcp.map((m) => (
          <li key={m.name} class="row mcp">
            <span class={`dot ${m.status}`} />
            <span class="row-main static">
              <span class="row-title">{m.name}</span>
              <span class={`row-sub ${m.status === 'failed' ? 'bad' : ''}`}>
                {m.status === 'failed' && m.error ? m.error : MCP_STATUS[m.status]}
                {m.status === 'connected' && m.toolCount !== undefined ? `, ${m.toolCount} tool${m.toolCount === 1 ? '' : 's'}` : ''}
                {m.source && m.status !== 'failed' ? `, ${m.source}` : ''}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              class={`switch ${m.enabled ? 'on' : ''}`}
              aria-checked={m.enabled}
              aria-label={`${m.enabled ? 'Disable' : 'Enable'} ${m.name}`}
              disabled={!m.canToggle || !s.capabilities.mcpToggle}
              onClick={() => send({ type: 'mcpToggle', name: m.name, enabled: !m.enabled })}
            >
              <span class="knob" />
            </button>
          </li>
        ))}
      </ul>
      {s.mcp.length > 0 && <p class="sheet-foot">{MCP_HELP[s.engine]}</p>}
      {(s.engine === 'direct' || s.engine === 'vscode-lm') && (
        <button type="button" class="btn small" onClick={() => send({ type: 'openSettings' })}>
          Open settings
        </button>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------- usage */

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div class="stat" title={title}>
      <div class="stat-value">{value}</div>
      <div class="stat-label">{label}</div>
    </div>
  );
}

function Stats({ u, messages }: { u: TokenUsage; messages: number }) {
  return (
    <div class="stats">
      <Stat label="input" value={compact(u.input)} title={`${u.input.toLocaleString()} uncached input tokens`} />
      <Stat label="output" value={compact(u.output)} title={`${u.output.toLocaleString()} output tokens`} />
      <Stat label="cached" value={compact(u.cacheRead + u.cacheWrite)} title={`${u.cacheRead.toLocaleString()} read from cache, ${u.cacheWrite.toLocaleString()} written`} />
      <Stat label="reasoning" value={compact(u.reasoning)} title={`${u.reasoning.toLocaleString()} reasoning tokens`} />
      <Stat label="cost" value={money(u.cost)} title="Reported by the engine, or estimated from the pricing you configured" />
      <Stat label={messages === 1 ? 'reply' : 'replies'} value={String(messages)} />
    </div>
  );
}

/** Tokens of each reply in the open session, newest first, so you can see what each turn cost. */
function ReplyRows({ s }: { s: ViewState }) {
  const replies = s.messages.filter((m) => m.role === 'assistant' && m.usage && !m.id.startsWith('local_'));
  if (replies.length < 2) return null;
  const max = Math.max(1, ...replies.map((m) => tokensAll(m.usage!)));
  const rows = replies.map((m, i) => ({ m, n: i + 1 })).reverse().slice(0, 30);
  return (
    <details class="reply-rows" open={replies.length <= 8}>
      <summary>Per reply ({replies.length})</summary>
      <table class="usage-table replies">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Model</th>
            <th scope="col" class="num">In</th>
            <th scope="col" class="num">Out</th>
            <th scope="col" class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, n }) => (
            <tr key={m.id} title={`${tokensIn(m.usage!).toLocaleString()} in (${m.usage!.cacheRead.toLocaleString()} from cache), ${tokensOut(m.usage!).toLocaleString()} out`}>
              <td class="num reply-n">{n}</td>
              <th scope="row" class="reply-model">
                <span class="reply-bar" style={{ width: `${Math.max(3, (tokensAll(m.usage!) / max) * 100)}%` }} />
                <span class="reply-model-name">{m.model?.modelId ?? ''}</span>
              </th>
              <td class="num">{compact(tokensIn(m.usage!))}</td>
              <td class="num">{compact(tokensOut(m.usage!))}</td>
              <td class="num">{m.usage!.cost > 0 ? money(m.usage!.cost) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Ranked bars: one hue, length encodes total tokens; the numbers sit beside each bar. */
function ModelRows({ rows, providerNames }: { rows: UsageRow[]; providerNames: Map<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => tokensAll(r.usage)));
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const key = `${r.engine}|${r.providerId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return (
    <div class="usage-groups">
      {[...groups.entries()].map(([key, list]) => {
        const first = list[0];
        const total = list.reduce((n, r) => n + tokensAll(r.usage), 0);
        const cost = list.reduce((n, r) => n + r.usage.cost, 0);
        return (
          <section key={key} class="usage-group">
            <header>
              <span class="usage-provider">{providerNames.get(key) ?? first.providerId}</span>
              <span class="tag">{ENGINE_LABELS[first.engine]}</span>
              <span class="spacer" />
              <span class="usage-total">
                {compact(total)} tokens{cost > 0 ? `, ${money(cost)}` : ''}
              </span>
            </header>
            <table class="usage-table">
              <tbody>
                {list.map((r) => {
                  const all = tokensAll(r.usage);
                  return (
                    <tr key={r.modelId} title={`${r.modelId}: ${tokensIn(r.usage).toLocaleString()} in, ${tokensOut(r.usage).toLocaleString()} out, ${r.messages} ${r.messages === 1 ? 'reply' : 'replies'}${r.usage.cost ? `, ${money(r.usage.cost)}` : ''}`} tabIndex={0}>
                      <th scope="row">{r.modelId}</th>
                      <td class="bar-cell">
                        <span class="bar" style={{ width: `${Math.max(2, (all / max) * 100)}%` }} />
                      </td>
                      <td class="num">{compact(tokensIn(r.usage))} in</td>
                      <td class="num">{compact(tokensOut(r.usage))} out</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

function Days({ days }: { days: { day: string; usage: TokenUsage }[] }) {
  const recent = days.slice(-14);
  const max = Math.max(1, ...recent.map((d) => tokensAll(d.usage)));
  if (recent.length < 2) return null;
  return (
    <section class="usage-section">
      <h3>Tokens per day</h3>
      <div class="days" role="img" aria-label={`Tokens per day for the last ${recent.length} active days`}>
        {recent.map((d) => {
          const all = tokensAll(d.usage);
          return (
            <div class="day" key={d.day} title={`${dayLabel(d.day)}: ${all.toLocaleString()} tokens${d.usage.cost ? `, ${money(d.usage.cost)}` : ''}`} tabIndex={0}>
              <span class="day-bar" style={{ height: `${Math.max(3, (all / max) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div class="days-axis">
        <span>{dayLabel(recent[0].day)}</span>
        <span>peak {compact(max)}</span>
        <span>{dayLabel(recent[recent.length - 1].day)}</span>
      </div>
    </section>
  );
}

export function UsagePanel({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const usage = s.usage;
  const session = s.sessionUsage;
  const providerNames = useMemo(() => new Map(s.providers.map((p) => [`${s.engine}|${p.id}`, p.name])), [s.providers, s.engine]);
  useEffect(() => send({ type: 'usageRefresh' }), []);
  return (
    <Sheet
      title="Token usage"
      onClose={onClose}
      actions={
        <button type="button" class="btn small quiet" onClick={() => send({ type: 'usageReset' })}>
          Reset
        </button>
      }
    >
      <section class="usage-section">
        <h3>This session{session?.title ? <span class="usage-session-title">: {session.title}</span> : null}</h3>
        {session ? (
          <>
            <Stats u={session.usage} messages={session.messages} />
            <ReplyRows s={s} />
            {session.byModel.length > 1 && <ModelRows rows={session.byModel} providerNames={providerNames} />}
            {session.byModel.length === 1 && (
              <p class="usage-note">
                All on {session.byModel[0].modelId} through {ENGINE_LABELS[session.engine]}.
              </p>
            )}
          </>
        ) : (
          <p class="empty-note">No tokens used in this session yet.</p>
        )}
      </section>

      <section class="usage-section">
        <h3>All sessions{usage ? ` since ${new Date(usage.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</h3>
        {usage && usage.messages > 0 ? <Stats u={usage.total} messages={usage.messages} /> : <p class="empty-note">Nothing recorded yet. Usage is counted from every reply, for every engine.</p>}
      </section>

      {usage && usage.byModel.length > 0 && (
        <section class="usage-section">
          <h3>By provider and model</h3>
          <ModelRows rows={usage.byModel} providerNames={providerNames} />
        </section>
      )}

      {usage && <Days days={usage.byDay} />}

      {usage && usage.sessions.length > 0 && (
        <section class="usage-section">
          <h3>Recent sessions</h3>
          <table class="usage-table sessions">
            <tbody>
              {usage.sessions.slice(0, 8).map((x) => (
                <tr key={`${x.engine}|${x.sessionId}`}>
                  <th scope="row">
                    {x.title || 'Untitled session'}
                    <span class="row-sub"> {ENGINE_LABELS[x.engine]}</span>
                  </th>
                  <td class="num">{compact(tokensAll(x.usage))}</td>
                  <td class="num">{x.usage.cost > 0 ? money(x.usage.cost) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p class="sheet-foot">Counts come from each provider's own usage report. Copilot does not report usage, so its numbers are estimates.</p>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- feedback */

const FEEDBACK_ORDER: FeedbackKind[] = ['bug', 'idea', 'other'];
const FEEDBACK_TABS: Record<FeedbackKind, string> = { bug: 'Bug', idea: 'Idea', other: 'Other' };
const FEEDBACK_HINTS: Record<FeedbackKind, string> = {
  bug: 'What did you do, what did you expect, and what happened instead?',
  idea: 'What would you like the chat to do, and what would that help you with?',
  other: 'Anything you want the maintainers to know.',
};

/**
 * Feedback form. It builds a pre-filled GitHub issue and opens it in the browser; the user
 * reviews and submits it there, so nothing leaves the machine from this form itself.
 */
export function FeedbackPanel({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>(s.feedbackDraft?.kind ?? 'bug');
  const [title, setTitle] = useState('');
  const [text, setText] = useState(s.feedbackDraft?.text ?? '');
  const [include, setInclude] = useState(true);
  const ready = text.trim().length > 0 || title.trim().length > 0;
  const submit = (copyLink = false) => {
    if (!ready) return;
    send({ type: 'feedback', kind, title, description: text, includeDiagnostics: include, ...(copyLink ? { copyLink: true } : {}) });
    onClose();
  };
  return (
    <Sheet title="Send feedback" onClose={onClose}>
      <p class="sheet-lede">Tell the maintainers what is broken or missing. This opens a pre-filled issue on GitHub in your browser; you review it there and press Submit.</p>
      <div class="segmented" role="tablist" aria-label="Kind of feedback">
        {FEEDBACK_ORDER.map((k) => (
          <button type="button" role="tab" key={k} aria-selected={kind === k} title={FEEDBACK_KINDS[k].label} class={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {FEEDBACK_TABS[k]}
          </button>
        ))}
      </div>
      <label class="field">
        <span class="field-label">Title (optional)</span>
        <input type="text" class="field-input" maxLength={120} placeholder="A short summary" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span class="field-label">Details</span>
        <textarea
          class="field-input feedback-text"
          rows={7}
          placeholder={FEEDBACK_HINTS[kind]}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
      </label>
      <label class="check">
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.currentTarget.checked)} />
        <span>Include diagnostics (versions, operating system, engine status)</span>
      </label>
      {include && (
        <details class="diagnostics">
          <summary>See exactly what is included</summary>
          <pre>{s.diagnostics || 'Collecting…'}</pre>
        </details>
      )}
      <p class="sheet-foot">Issues on GitHub are public and need a GitHub account. Your prompts, files, paths and keys are never added. Leave out anything private.</p>
      <p class="sheet-foot">
        Is your browser signed in to GitHub with a company-managed account? Those cannot post outside the company, and GitHub only says "Unable to create issue". Use <b>Copy link</b> and open it in a private window or another browser with a personal account.
      </p>
      <div class="sheet-actions">
        <button type="button" class="btn primary" disabled={!ready} title="Opens github.com in your browser (Ctrl+Enter)" onClick={() => submit()}>
          Continue on GitHub
        </button>
        <button type="button" class="btn" disabled={!ready} title="Copy the pre-filled link, to open it where a personal GitHub account is signed in" onClick={() => submit(true)}>
          Copy link
        </button>
        <button type="button" class="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
