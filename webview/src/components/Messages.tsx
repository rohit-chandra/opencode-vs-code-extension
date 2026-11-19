import { Component, h } from 'preact';
import type { ComponentChildren, FunctionComponent } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatMessage, Part } from '../../../src/shared/types';
import { compact, money, tokensIn, tokensOut } from '../format';
import { IconBrain, IconCheck, IconChevron, IconClose, IconCopy, IconFile, IconImage, IconRefresh, IconTool, IconWarn } from '../icons';
import { renderBlocks } from '../markdown';
import { send } from '../store';

/** Skip re-rendering a component whose props are shallowly equal (a tiny `memo`, without preact/compat). */
function memo<P extends object>(render: FunctionComponent<P>): FunctionComponent<P> {
  class Memo extends Component<P> {
    override shouldComponentUpdate(next: P): boolean {
      const prev = this.props as Record<string, unknown>;
      for (const k in next) if ((next as Record<string, unknown>)[k] !== prev[k]) return true;
      return false;
    }
    render(): ComponentChildren {
      return h(render as FunctionComponent<object>, this.props);
    }
  }
  return Memo as unknown as FunctionComponent<P>;
}

const MdBlock = memo(function MdBlock({ html }: { html: string }) {
  return <div class="mdb" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Markdown rendered block by block, so a streaming reply only touches the DOM of its last block. */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => renderBlocks(text), [text]);
  return (
    <div class="md">
      {blocks.map((b, i) => (
        <MdBlock key={i} html={b.html} />
      ))}
    </div>
  );
}

function Reasoning({ part, live }: { part: Extract<Part, { type: 'reasoning' }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!part.text.trim()) return null;
  return (
    <div class={`fold reasoning ${open ? 'open' : ''}`}>
      <button type="button" class="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <IconBrain size={14} />
        <span class="fold-title">{live ? 'Thinking' : 'Thought process'}</span>
        <IconChevron size={12} class="chev" />
      </button>
      {open && <div class="fold-body reasoning-text">{part.text}</div>}
    </div>
  );
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolCard({ part }: { part: Extract<Part, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const failed = part.status === 'error';
  const running = part.status === 'running' || part.status === 'pending';
  const input = pretty(part.input);
  return (
    <div class={`fold tool ${part.status} ${open ? 'open' : ''}`}>
      <button type="button" class="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class={`tool-state ${part.status}`} aria-label={part.status}>
          {running ? <span class="spinner" /> : failed ? <IconClose size={12} /> : <IconCheck size={12} />}
        </span>
        <IconTool size={13} />
        <span class="tool-name">{part.tool}</span>
        {part.title && <span class="tool-title">{part.title}</span>}
        <IconChevron size={12} class="chev" />
      </button>
      {open && (
        <div class="fold-body">
          {input && input !== '{}' && (
            <>
              <div class="fold-label">Input</div>
              <pre class="tool-io">{input}</pre>
            </>
          )}
          {part.output !== undefined && part.output !== '' && (
            <>
              <div class="fold-label">Output</div>
              <pre class="tool-io">{part.output}</pre>
            </>
          )}
          {part.error && (
            <>
              <div class="fold-label">Error</div>
              <pre class="tool-io error">{part.error}</pre>
            </>
          )}
          {running && !part.output && <div class="fold-label">Still running…</div>}
        </div>
      )}
    </div>
  );
}

function FileChip({ part }: { part: Extract<Part, { type: 'file' }> }) {
  const isImage = part.mime.startsWith('image/');
  const path = part.url?.startsWith('file://') ? decodeURIComponent(new URL(part.url).pathname) : part.url && !part.url.includes('://') ? part.url : undefined;
  return (
    <button type="button" class="chip file" disabled={!path} title={path ?? part.filename} onClick={() => path && send({ type: 'openFile', path })}>
      {isImage ? <IconImage size={13} /> : <IconFile size={13} />}
      <span>{part.filename}</span>
    </button>
  );
}

function PartView({ part, live }: { part: Part; live: boolean }) {
  switch (part.type) {
    case 'text':
      return part.text ? <Markdown text={part.text} /> : null;
    case 'reasoning':
      return <Reasoning part={part} live={live} />;
    case 'tool':
      return <ToolCard part={part} />;
    case 'file':
      return <FileChip part={part} />;
    case 'notice':
      return (
        <div class={`notice ${part.level}`}>
          {part.level !== 'info' && <IconWarn size={13} />}
          <span>{part.text}</span>
        </div>
      );
    default:
      return null;
  }
}

/** The reply as Markdown: its text parts, without thinking or tool calls. */
export function replyText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function CopyReply({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      class={`msg-action copy-reply ${copied ? 'done' : ''}`}
      title={copied ? 'Copied' : 'Copy response'}
      aria-label={copied ? 'Copied' : 'Copy response'}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: 'copy', text: replyText(message) });
        setCopied(true);
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      <span class="msg-action-label">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

const Message = memo(function Message({ message, live }: { message: ChatMessage; live: boolean }) {
  if (message.role === 'user') {
    const files = message.parts.filter((p) => p.type === 'file');
    const text = message.parts
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n');
    return (
      <div class="msg user" data-message-id={message.id}>
        {text && <div class="bubble">{text}</div>}
        {files.length > 0 && <div class="chips">{files.map((p) => <FileChip key={p.id} part={p as Extract<Part, { type: 'file' }>} />)}</div>}
      </div>
    );
  }
  const u = message.usage;
  const empty = message.parts.length === 0 && !message.error;
  // Offered once the reply has stopped streaming, so the copy is the whole answer.
  const canCopy = !live && message.parts.some((p) => p.type === 'text' && p.text.trim() !== '');
  // Written by the extension itself (/help, /doctor, a share link), not by a model: it can be closed.
  const local = message.id.startsWith('local_');
  return (
    <div class={`msg assistant ${local ? 'local' : ''}`} data-message-id={message.id}>
      {local && (
        <button type="button" class="icon-btn msg-close" title="Close" aria-label="Close this message" onClick={() => send({ type: 'dismissMessage', id: message.id })}>
          <IconClose size={12} />
        </button>
      )}
      {message.parts.map((p) => (
        <PartView key={p.id} part={p} live={live} />
      ))}
      {empty && live && (
        <div class="typing" aria-label="Working">
          <span />
          <span />
          <span />
        </div>
      )}
      {message.error && (
        <div class="notice error">
          <IconWarn size={13} />
          <span>{message.error}</span>
        </div>
      )}
      {(canCopy || (u && message.completedAt)) && (
        <div class="msg-foot">
          {canCopy && <CopyReply message={message} />}
          {u && message.completedAt && (
            <div class="meta" title={`${message.model ? `${message.model.modelId} · ` : ''}Input ${u.input.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · output ${u.output.toLocaleString()} · reasoning ${u.reasoning.toLocaleString()}${u.cost > 0 ? ` · ${money(u.cost)} (reported by the engine, or estimated from list prices)` : ''}`}>
              <span>{compact(tokensIn(u))} in</span>
              <span>{compact(tokensOut(u))} out</span>
              {u.cost > 0 && <span>{money(u.cost)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function MessageList({ messages, busy, canRetry }: { messages: ChatMessage[]; busy: boolean; canRetry: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [jump, setJump] = useState(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setJump(!stick.current);
  };
  // Keep the newest text in view while it streams, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [messages[0]?.sessionId]);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]');
    if (action) {
      const code = action.closest('.code')?.querySelector('code')?.textContent ?? '';
      if (action.dataset.action === 'copy') {
        send({ type: 'copy', text: code });
        const label = action.textContent;
        action.textContent = 'Copied';
        setTimeout(() => (action.textContent = label), 1200);
      } else if (action.dataset.action === 'insert') {
        send({ type: 'insertCode', text: code });
      }
      return;
    }
    const link = target.closest<HTMLElement>('[data-href]');
    if (link) {
      e.preventDefault();
      const href = link.dataset.href ?? '';
      if (/^https?:\/\//i.test(href)) send({ type: 'openExternal', url: href });
      else if (href && !href.startsWith('#')) send({ type: 'openFile', path: decodeURIComponent(href.replace(/^file:\/\//, '').replace(/#.*$/, '')) });
    }
  };

  const lastId = messages[messages.length - 1]?.id;
  return (
    <div class="messages" ref={scroller} onScroll={onScroll} onClick={onClick}>
      {messages.map((m) => (
        <Message key={m.id} message={m} live={busy && m.id === lastId} />
      ))}
      {canRetry && !busy && messages.length > 0 && (
        <div class="retry-row">
          <button type="button" class="btn small retry" title="Send your last message again" onClick={() => send({ type: 'retry' })}>
            <IconRefresh size={12} /> Retry
          </button>
          <button type="button" class="btn small quiet report" title="Tell the maintainers about this (opens a pre-filled GitHub issue)" onClick={() => send({ type: 'openFeedback', kind: 'bug' })}>
            Report a problem
          </button>
        </div>
      )}
      {jump && (
        <button
          type="button"
          class="jump"
          onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
            setJump(false);
          }}
        >
          <IconChevron size={12} /> Latest
        </button>
      )}
    </div>
  );
}
