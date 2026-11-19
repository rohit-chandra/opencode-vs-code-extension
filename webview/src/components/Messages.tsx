import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatMessage, Part } from '../../../src/shared/types';
import { compact, money, tokensIn, tokensOut } from '../format';
import { IconBrain, IconCheck, IconChevron, IconClose, IconFile, IconImage, IconTool, IconWarn } from '../icons';
import { renderMarkdown } from '../markdown';
import { send } from '../store';

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
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

function Message({ message, live }: { message: ChatMessage; live: boolean }) {
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
  return (
    <div class="msg assistant" data-message-id={message.id}>
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
      {u && message.completedAt && (
        <div class="meta" title={`Input ${u.input.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · output ${u.output.toLocaleString()} · reasoning ${u.reasoning.toLocaleString()}`}>
          {message.model && <span class="meta-model">{message.model.modelId}</span>}
          <span>{compact(tokensIn(u))} in</span>
          <span>{compact(tokensOut(u))} out</span>
          {u.cost > 0 && <span>{money(u.cost)}</span>}
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages, busy }: { messages: ChatMessage[]; busy: boolean }) {
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
