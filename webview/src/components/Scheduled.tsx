import { useEffect, useState } from 'preact/hooks';
import type { ViewState } from '../../../src/shared/protocol';
import { clockTime, fromLocalInput, toLocalInput, untilLabel, whenLabel, whenPresets, HOUR } from '../../../src/shared/sendLater';
import { ENGINE_LABELS } from '../../../src/shared/types';
import type { ScheduledMessage } from '../../../src/shared/types';
import { useTick } from '../hooks';
import { IconClock, IconClose, IconPencil, IconSend, IconWarn } from '../icons';
import { send } from '../store';

/**
 * The choices of "Send later": a few presets, and a date and time of your own.
 * Used by the message box (to schedule) and by a scheduled message (to move it).
 */
export function WhenMenu({ busy, onPick, label = 'Schedule' }: { busy: boolean; onPick: (at: number) => void; label?: string }) {
  const now = Date.now();
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => toLocalInput(now + HOUR));
  const at = fromLocalInput(value);
  const valid = at !== undefined && at > now;
  return (
    <div class="menu when-menu align-right" role="menu" aria-label="Send later">
      {whenPresets(now, busy).map((p) => (
        <button type="button" role="menuitem" class="menu-item" key={p.label} onClick={() => onPick(p.at)}>
          <span class="menu-label">{p.label}</span>
          {p.at > now && <span class="menu-sub">{clockTime(p.at)}</span>}
        </button>
      ))}
      <div class="menu-sep" />
      {/* Kept in the page when the picker opens: a click on a button that vanishes would read as a click outside the menu. */}
      <button type="button" role="menuitem" class="menu-item" hidden={custom} onClick={() => setCustom(true)}>
        <span class="menu-label">Choose date and time…</span>
      </button>
      {custom && (
        <div class="when-custom">
          <input
            type="datetime-local"
            aria-label="Date and time"
            value={value}
            min={toLocalInput(now)}
            ref={(el) => {
              if (el && document.activeElement !== el) el.focus();
            }}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) onPick(at);
            }}
          />
          <button type="button" class="btn small primary" disabled={!valid} onClick={() => valid && onPick(at)}>
            {label}
          </button>
        </div>
      )}
      <div class="menu-note">Kept on this computer. VS Code has to be open at that time; a message that is missed is sent when the chat is next running.</div>
    </div>
  );
}

function Item({ m, s, now }: { m: ScheduledMessage; s: ViewState; now: number }) {
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!moving) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.scheduled-move')) setMoving(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [moving]);
  const here = m.engine === s.engine && m.sessionId === s.sessionId;
  const due = m.sendAt <= now;
  const where = here ? '' : m.sessionId ? `in "${m.sessionTitle || 'another session'}"${m.engine !== s.engine ? `, ${ENGINE_LABELS[m.engine]}` : ''}` : `in a new ${m.engine !== s.engine ? `${ENGINE_LABELS[m.engine]} ` : ''}session`;
  const when = m.problem ? 'Not sent' : m.held ? `Missed: was due ${whenLabel(m.sendAt, now)}` : due ? (s.activity !== 'idle' ? 'After this reply' : 'Sending…') : `${untilLabel(m.sendAt, now)} · ${whenLabel(m.sendAt, now)}`;
  const files = m.attachments.length;
  return (
    <li class={`scheduled-item ${m.problem || m.held ? 'stuck' : ''}`}>
      <span class="scheduled-icon">{m.problem || m.held ? <IconWarn size={13} /> : <IconClock size={13} />}</span>
      <div class="scheduled-main" title={m.text}>
        <div class="scheduled-when">
          {when}
          {where && <span class="scheduled-where"> {where}</span>}
        </div>
        <div class="scheduled-text">
          {m.text || '(attachments only)'}
          {files > 0 && <span class="scheduled-files"> · {files} {files === 1 ? 'attachment' : 'attachments'}</span>}
        </div>
        {m.problem && <div class="scheduled-problem">{m.problem}</div>}
      </div>
      <span class="scheduled-actions">
        <button type="button" class="icon-btn" title="Send now" aria-label="Send now" onClick={() => send({ type: 'scheduledSendNow', id: m.id })}>
          <IconSend size={13} />
        </button>
        <button type="button" class="icon-btn" title="Edit: back into the message box" aria-label="Edit" onClick={() => send({ type: 'scheduledEdit', id: m.id })}>
          <IconPencil size={13} />
        </button>
        <span class="menu-anchor scheduled-move">
          <button type="button" class="icon-btn" title="Change the time" aria-label="Change the time" aria-haspopup="menu" aria-expanded={moving} onClick={() => setMoving(!moving)}>
            <IconClock size={13} />
          </button>
          {moving && <WhenMenu busy={false} label="Move" onPick={(at) => (setMoving(false), send({ type: 'scheduledReschedule', id: m.id, at }))} />}
        </span>
        <button type="button" class="icon-btn" title="Cancel" aria-label="Cancel this scheduled message" onClick={() => send({ type: 'scheduledCancel', id: m.id })}>
          <IconClose size={13} />
        </button>
      </span>
    </li>
  );
}

/** Messages waiting to be sent later, above the message box: this conversation's first. */
export function Scheduled({ s }: { s: ViewState }) {
  // The countdowns ("in 28 min") move on their own.
  useTick(s.scheduled.length > 0, 15_000);
  const [open, setOpen] = useState(true);
  if (s.scheduled.length === 0) return null;
  const now = Date.now();
  const here = (m: ScheduledMessage) => m.engine === s.engine && m.sessionId === s.sessionId;
  const list = [...s.scheduled].sort((a, b) => Number(here(b)) - Number(here(a)) || a.sendAt - b.sendAt);
  return (
    <section class="scheduled" aria-label="Scheduled messages">
      <button type="button" class="scheduled-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconClock size={12} />
        <span>
          Scheduled ({list.length}){!open && `: next ${list.some((m) => m.sendAt <= now) ? 'now' : untilLabel(Math.min(...list.map((m) => m.sendAt)), now)}`}
        </span>
      </button>
      {open && (
        <ul class="scheduled-list">
          {list.map((m) => (
            <Item key={m.id} m={m} s={s} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
