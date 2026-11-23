import { Component, h } from 'preact';
import type { ComponentChildren, FunctionComponent } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatMessage, Part } from '../../../src/shared/types';
import { compact, money, tokensCached, tokensIn, tokensOut, usageDetail } from '../format';
import { IconBrain, IconCheck, IconChevron, IconClose, IconCopy, IconFile, IconImage, IconRefresh, IconTool, IconWarn } from '../icons';
import { splitPreviewPrompt } from '../../../src/shared/htmlPreview';
import { renderBlocks } from '../markdown';
import { mountPreviews, showPreview, standaloneHtml } from '../preview';
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
  const el = useRef<HTMLDivElement>(null);
  // A finished `html-preview` block is drawn in place of its source (see preview.ts).
  useLayoutEffect(() => {
    if (el.current && html.includes('data-preview="auto"')) mountPreviews(el.current);
  }, [html]);
  return <div class="mdb" ref={el} dangerouslySetInnerHTML={{ __html: html }} />;
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
    // `/preview` adds instructions for the model after a marker; the bubble shows what the user typed.
    const { text, preview } = splitPreviewPrompt(
      message.parts
        .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n'),
    );
    return (
      <div class="msg user" data-message-id={message.id}>
        {text && (
          <div class="bubble">
            {text}
            {preview && (
              <span class="bubble-tag" title="Sent with /preview: the model is asked to answer with a visual that is drawn in the chat">
                HTML preview
              </span>
            )}
          </div>
        )}
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
            <div
              class="meta"
              title={`${message.model ? `${message.model.modelId}: ` : ''}${usageDetail(u)}.${(message.calls ?? 1) > 1 ? ` This reply took ${message.calls} model calls, and each one reads the conversation again.` : ''}${message.contextTokens ? ` Context after this reply: ${message.contextTokens.toLocaleString()} tokens.` : ''}${u.cost > 0 ? ` ${money(u.cost)} is what the engine reported, or an estimate from list prices.` : ''}`}
            >
              {/* The model that answered, as the provider names it: a model's own idea of its name can be out of date. */}
              {canCopy && message.model && <span class="meta-model">{message.model.modelId}</span>}
              <span>{compact(tokensIn(u))} in</span>
              {tokensCached(u) > 0 && <span class="meta-cached">{compact(tokensCached(u))} cached</span>}
              <span>{compact(tokensOut(u))} out</span>
              {(message.calls ?? 1) > 1 && <span>{message.calls} calls</span>}
              {u.cost > 0 && <span>{money(u.cost)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** How far from the end the reader has to be before the "Latest" button is offered. */
const JUMP_AFTER_PX = 160;
/** A scroll counts as the reader's own for this long after their last wheel, key or touch. */
const USER_SCROLL_MS = 900;

/**
 * Keeps the newest text in view while a reply streams, without ever fighting the reader.
 *
 * The list follows the end until the reader scrolls up, and follows again once they are back
 * at the end. Three things make that smooth:
 *
 *  - Whether to follow is decided from what the reader did (wheel, keys, touch, dragging the
 *    scroll bar), not from how close to the end the view happens to be. A distance check
 *    snaps the view back during the first pixels of a scroll up, because a new chunk of the
 *    reply arrives before the scroll has got anywhere.
 *  - The view is moved when the content changes size (a ResizeObserver), not on every render.
 *  - Nothing in the scrolled content appears or disappears with the scroll position: the
 *    "Latest" button floats over the list instead of sitting in it.
 */
function useFollowEnd(sessionId: string | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const userAt = useRef(0);
  const dragging = useRef(false);
  const [jump, setJump] = useState(false);

  const pin = () => {
    const el = scroller.current;
    if (!el || !follow.current) return;
    const top = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top;
    lastTop.current = el.scrollTop;
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const distance = el.scrollHeight - top - el.clientHeight;
    const byUser = dragging.current || Date.now() - userAt.current < USER_SCROLL_MS;
    if (distance <= 2) follow.current = true;
    else if (byUser && top < lastTop.current - 1) follow.current = false;
    lastTop.current = top;
    setJump(!follow.current && distance > JUMP_AFTER_PX);
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const touched = () => (userAt.current = Date.now());
    const onWheel = (e: WheelEvent) => {
      touched();
      // Let go at once: the scroll this wheel turn causes arrives a frame later, and a chunk
      // of the reply that lands in between must not pull the view back down.
      if (e.deltaY < 0 && el.scrollTop > 0) follow.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      touched();
      const typing = e.target instanceof Element && !!e.target.closest('textarea, input, select');
      if ((e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') && el.scrollTop > 0 && !typing) follow.current = false;
    };
    // A press on the scroller itself is a press on its scroll bar.
    const onDown = (e: PointerEvent) => {
      touched();
      if (e.target === el) dragging.current = true;
    };
    const onUp = () => {
      if (dragging.current) touched();
      dragging.current = false;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', touched, { passive: true });
    el.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('keydown', onKey, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    // The content grew (a chunk, an opened tool card) or the view changed height (the message
    // box grew, the panel was resized): stay at the end if that is where the reader is.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(pin);
    observer?.observe(el);
    if (content.current) observer?.observe(content.current);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', touched);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      observer?.disconnect();
    };
  }, []);

  // Another conversation starts at its end.
  useLayoutEffect(() => {
    follow.current = true;
    setJump(false);
    pin();
  }, [sessionId]);

  const toEnd = () => {
    const el = scroller.current;
    if (!el) return;
    follow.current = true;
    setJump(false);
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // A long way: go there. Close by: glide, so the eye can keep its place.
    if (distance > el.clientHeight * 3) pin();
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return { scroller, content, jump, onScroll, pin, toEnd };
}

export function MessageList({ messages, busy, canRetry }: { messages: ChatMessage[]; busy: boolean; canRetry: boolean }) {
  const { scroller, content, jump, onScroll, pin, toEnd } = useFollowEnd(messages[0]?.sessionId);
  // Before the first paint of new content, so a sent message never shows a frame out of place.
  useLayoutEffect(pin, [messages]);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]');
    if (action) {
      const code = action.closest('.code')?.querySelector('code')?.textContent ?? '';
      const block = action.closest<HTMLElement>('.code');
      if (action.dataset.action === 'preview' && block) {
        showPreview(block, !block.classList.contains('previewing'));
      } else if (action.dataset.action === 'expand' && block) {
        action.textContent = block.classList.toggle('expanded') ? 'Fit' : 'Expand';
      } else if (action.dataset.action === 'save-html') {
        send({ type: 'saveHtml', html: standaloneHtml(code) });
      } else if (action.dataset.action === 'copy') {
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
    <div class="messages-wrap">
      <div class="messages" ref={scroller} onScroll={onScroll} onClick={onClick}>
        <div class="messages-list" ref={content}>
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
        </div>
      </div>
      {jump && (
        <button type="button" class="jump" onClick={toEnd}>
          <IconChevron size={12} /> Latest
        </button>
      )}
    </div>
  );
}
