import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { filterCommands } from '../../../src/core/slashCommands';
import type { ViewState } from '../../../src/shared/protocol';
import { ENGINE_LABELS } from '../../../src/shared/types';
import type { Attachment, EngineId, SlashCommand } from '../../../src/shared/types';
import { IconChevron, IconClip, IconClose, IconFile, IconImage, IconSend, IconStop } from '../icons';
import { send, store } from '../store';

type Popup = { kind: 'slash'; items: SlashCommand[]; index: number } | { kind: 'file'; items: { path: string; relative: string }[]; index: number; start: number; query: string } | undefined;

const ENGINE_ORDER: EngineId[] = ['opencode', 'direct', 'claude-code', 'codex', 'vscode-lm'];

function fileToAttachment(file: File): Promise<Attachment | undefined> {
  return new Promise((resolve) => {
    if (file.size > 5 * 1024 * 1024) return resolve(undefined);
    const reader = new FileReader();
    const image = file.type.startsWith('image/');
    reader.onerror = () => resolve(undefined);
    reader.onload = () => {
      const name = file.name || (image ? `pasted-${Date.now()}.${file.type.split('/')[1] ?? 'png'}` : 'pasted.txt');
      if (image) resolve({ id: '', kind: 'image', name, mime: file.type, dataUrl: String(reader.result), size: file.size });
      else resolve({ id: '', kind: 'file', name, mime: 'text/plain', text: String(reader.result), size: file.size });
    };
    if (image) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

/** Paths or file:// URIs carried by a drag from the VS Code explorer or editor tabs. */
export function droppedPaths(dt: DataTransfer): string[] {
  const out = new Set<string>();
  for (const type of ['resourceurls', 'codefiles']) {
    try {
      for (const v of JSON.parse(dt.getData(type) || '[]') as string[]) out.add(v);
    } catch {
      /* not JSON */
    }
  }
  for (const line of (dt.getData('text/uri-list') || '').split(/\r?\n/)) if (line.startsWith('file://')) out.add(line.trim());
  // VS Code reports the same file both as a path and as a URI.
  const uris = [...out].filter((v) => v.startsWith('file://'));
  return uris.length ? uris : [...out];
}

export function Composer({ s, onOpenPanel }: { s: ViewState; onOpenPanel: (p: 'models') => void }) {
  const [text, setText] = useState('');
  const [popup, setPopup] = useState<Popup>();
  const [menu, setMenu] = useState<'engine' | 'agent' | undefined>();
  const input = useRef<HTMLTextAreaElement>(null);
  const searchSeq = useRef(0);
  const busy = s.activity !== 'idle';

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(
    () =>
      store.onHostMessage((m) => {
        if (m.type === 'focusInput') input.current?.focus();
        if (m.type === 'insertText') {
          setText((t) => (t ? `${t}\n${m.text}` : m.text));
          input.current?.focus();
        }
      }),
    [],
  );
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu-anchor')) setMenu(undefined);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const refreshPopup = (value: string, caret: number) => {
    const slash = /^\/([\w:.-]*)$/.exec(value.slice(0, caret));
    if (slash && !value.slice(caret).trim()) {
      const items = filterCommands(s.commands, slash[1], 40);
      setPopup(items.length ? { kind: 'slash', items, index: 0 } : undefined);
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (at) {
      const query = at[2];
      const start = caret - query.length - 1;
      const seq = ++searchSeq.current;
      void store.searchFiles(query).then((items) => {
        if (seq !== searchSeq.current) return;
        setPopup(items.length ? { kind: 'file', items, index: 0, start, query } : undefined);
      });
      return;
    }
    searchSeq.current++;
    setPopup(undefined);
  };

  const submit = (value = text) => {
    if (!value.trim() && s.attachments.length === 0) return;
    send({ type: 'send', text: value });
    setText('');
    setPopup(undefined);
  };

  const accept = (p: NonNullable<Popup>, index = p.index) => {
    if (p.kind === 'slash') {
      const cmd = p.items[index];
      if (!cmd) return;
      // Commands without arguments run right away; the others wait for their argument.
      if (!cmd.argumentHint) submit(`/${cmd.name}`);
      else {
        setText(`/${cmd.name} `);
        setPopup(undefined);
        input.current?.focus();
      }
    } else {
      const file = p.items[index];
      if (!file) return;
      const before = text.slice(0, p.start);
      const after = text.slice(p.start + 1 + p.query.length);
      setText(`${before}@${file.relative} ${after.replace(/^\s/, '')}`);
      send({ type: 'addPaths', paths: [file.path] });
      setPopup(undefined);
      input.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (popup) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = popup.items.length;
        setPopup({ ...popup, index: (popup.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(popup);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopup(undefined);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy || text.trim().startsWith('/')) submit();
    }
    if (e.key === 'Escape' && busy) send({ type: 'abort' });
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) void fileToAttachment(f).then((a) => a && send({ type: 'addAttachment', attachment: a }));
  };

  const engineStatus = s.engines.find((e) => e.engine === s.engine);
  const modelInfo = s.model && s.providers.flatMap((p) => p.models).find((m) => m.providerId === s.model!.providerId && m.modelId === s.model!.modelId);

  return (
    <div class="composer">
      {popup && (
        <div class="popup" role="listbox" aria-label={popup.kind === 'slash' ? 'Commands' : 'Files'}>
          {popup.kind === 'slash'
            ? popup.items.map((c, i) => (
                <button type="button" role="option" aria-selected={i === popup.index} key={c.name} class={`popup-item ${i === popup.index ? 'active' : ''}`} onMouseDown={(e) => (e.preventDefault(), accept(popup, i))} ref={(el) => {
                    if (i === popup.index) el?.scrollIntoView({ block: 'nearest' });
                  }}>
                  <span class="popup-name">
                    /{c.name}
                    {c.argumentHint && <span class="popup-hint"> {c.argumentHint}</span>}
                  </span>
                  <span class="popup-desc">{c.description}</span>
                  {c.source !== 'builtin' && <span class="tag">{c.source === 'engine' ? ENGINE_LABELS[s.engine] : c.source}</span>}
                </button>
              ))
            : popup.items.map((f, i) => (
                <button type="button" role="option" aria-selected={i === popup.index} key={f.path} class={`popup-item ${i === popup.index ? 'active' : ''}`} onMouseDown={(e) => (e.preventDefault(), accept(popup, i))} ref={(el) => {
                    if (i === popup.index) el?.scrollIntoView({ block: 'nearest' });
                  }}>
                  <IconFile size={13} />
                  <span class="popup-name">{f.relative.split('/').pop()}</span>
                  <span class="popup-desc">{f.relative}</span>
                </button>
              ))}
        </div>
      )}

      {s.attachments.length > 0 && (
        <div class="chips attachments">
          {s.attachments.map((a) => (
            <span class="chip" key={a.id} title={a.path ?? a.name}>
              {a.kind === 'image' && a.dataUrl ? <img class="thumb" src={a.dataUrl} alt="" /> : a.kind === 'image' ? <IconImage size={13} /> : <IconFile size={13} />}
              <span>{a.name}</span>
              <button type="button" class="chip-x" aria-label={`Remove ${a.name}`} onClick={() => send({ type: 'removeAttachment', id: a.id })}>
                <IconClose size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div class="input-box">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={s.trusted ? 'Ask anything. / for commands, @ for files' : 'Trust this workspace to chat'}
          aria-label="Message"
          onInput={(e) => {
            const el = e.currentTarget;
            setText(el.value);
            refreshPopup(el.value, el.selectionStart ?? el.value.length);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setTimeout(() => setPopup(undefined), 120)}
        />
        <div class="input-actions">
          <button type="button" class="icon-btn" title="Attach files" aria-label="Attach files" onClick={() => send({ type: 'pickFiles' })}>
            <IconClip />
          </button>
          {busy ? (
            <button type="button" class="send stop" title="Stop (Esc)" aria-label="Stop" onClick={() => send({ type: 'abort' })}>
              <IconStop />
            </button>
          ) : (
            <button type="button" class="send" title="Send (Enter)" aria-label="Send" disabled={!text.trim() && s.attachments.length === 0} onClick={() => submit()}>
              <IconSend />
            </button>
          )}
        </div>
      </div>

      <div class="controls">
        <span class="menu-anchor">
          <button type="button" class="pill" aria-haspopup="menu" aria-expanded={menu === 'engine'} title={engineStatus?.detail ?? `Engine: ${ENGINE_LABELS[s.engine]}`} onClick={() => setMenu(menu === 'engine' ? undefined : 'engine')}>
            <span class={`dot ${engineStatus?.state ?? 'idle'}`} />
            <span class="pill-text">{ENGINE_LABELS[s.engine]}</span>
            <IconChevron size={11} />
          </button>
          {menu === 'engine' && (
            <div class="menu" role="menu">
              {ENGINE_ORDER.filter((id) => s.engines.some((e) => e.engine === id)).map((id) => {
                const st = s.engines.find((e) => e.engine === id)!;
                return (
                  <button type="button" role="menuitemradio" aria-checked={id === s.engine} class={`menu-item ${id === s.engine ? 'active' : ''}`} key={id} onClick={() => (setMenu(undefined), send({ type: 'setEngine', engine: id }))}>
                    <span class={`dot ${st.state}`} />
                    <span class="menu-label">{ENGINE_LABELS[id]}</span>
                    <span class="menu-sub">{st.state === 'ready' ? (st.version ? `v${st.version}` : 'ready') : st.state === 'unavailable' ? 'not available' : ''}</span>
                  </button>
                );
              })}
              <div class="menu-sep" />
              <button type="button" role="menuitem" class="menu-item" onClick={() => (setMenu(undefined), send({ type: 'manageProviders' }))}>
                <span class="menu-label">Providers and API keys…</span>
              </button>
            </div>
          )}
        </span>

        <button type="button" class="pill model" title={s.model ? `${s.model.providerId}/${s.model.modelId}` : 'Choose a model'} onClick={() => onOpenPanel('models')}>
          <span class="pill-text">{modelInfo?.name ?? s.model?.modelId ?? 'Choose model'}</span>
          <IconChevron size={11} />
        </button>

        {s.agents.length > 0 && (
          <span class="menu-anchor">
            <button type="button" class="pill" aria-haspopup="menu" aria-expanded={menu === 'agent'} title="Agent" onClick={() => setMenu(menu === 'agent' ? undefined : 'agent')}>
              <span class="pill-text">{s.agent ?? 'agent'}</span>
              <IconChevron size={11} />
            </button>
            {menu === 'agent' && (
              <div class="menu" role="menu">
                {s.agents.map((a) => (
                  <button type="button" role="menuitemradio" aria-checked={a.name === s.agent} class={`menu-item ${a.name === s.agent ? 'active' : ''}`} key={a.name} title={a.description} onClick={() => (setMenu(undefined), send({ type: 'setAgent', agent: a.name }))}>
                    <span class="menu-label">{a.name}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        )}

      </div>
    </div>
  );
}
