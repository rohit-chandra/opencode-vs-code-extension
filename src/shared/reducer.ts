import type { ChatMessage, EngineEvent, Part } from './types';

/**
 * Apply a streaming engine event to the message list of one session.
 * Pure and shared: the extension host keeps the authoritative copy, the webview applies
 * the same events to its own copy so streaming does not need full re-sends.
 * Returns the same array instance when nothing changed.
 */
export function applyMessageEvent(messages: ChatMessage[], event: EngineEvent, sessionId: string): ChatMessage[] {
  switch (event.type) {
    case 'message.updated': {
      if (event.message.sessionId !== sessionId) return messages;
      const i = messages.findIndex((m) => m.id === event.message.id);
      if (i === -1) return insertSorted(messages, event.message);
      const next = messages.slice();
      next[i] = event.infoOnly ? { ...event.message, parts: messages[i].parts } : event.message;
      return next;
    }
    case 'message.removed': {
      if (event.sessionId !== sessionId) return messages;
      const next = messages.filter((m) => m.id !== event.messageId);
      return next.length === messages.length ? messages : next;
    }
    case 'part.updated':
      if (event.sessionId !== sessionId) return messages;
      return withMessage(messages, event.messageId, sessionId, (m) => {
        const i = m.parts.findIndex((p) => p.id === event.part.id);
        const parts = m.parts.slice();
        if (i === -1) parts.push(event.part);
        else parts[i] = event.part;
        return { ...m, parts };
      });
    case 'part.delta':
      if (event.sessionId !== sessionId) return messages;
      return withMessage(messages, event.messageId, sessionId, (m) => {
        const i = m.parts.findIndex((p) => p.id === event.partId);
        const parts = m.parts.slice();
        if (i === -1) {
          parts.push({ id: event.partId, type: 'text', text: event.delta });
        } else {
          const p = parts[i];
          if (p.type !== 'text' && p.type !== 'reasoning') return m;
          parts[i] = { ...p, text: p.text + event.delta } as Part;
        }
        return { ...m, parts };
      });
    case 'part.removed':
      if (event.sessionId !== sessionId) return messages;
      return withMessage(messages, event.messageId, sessionId, (m) => {
        const parts = m.parts.filter((p) => p.id !== event.partId);
        return parts.length === m.parts.length ? m : { ...m, parts };
      });
    default:
      return messages;
  }
}

function withMessage(messages: ChatMessage[], messageId: string, sessionId: string, update: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === messageId);
  if (i === -1) {
    // A part arrived before its message header: create a placeholder that `message.updated` will complete.
    const placeholder: ChatMessage = { id: messageId, sessionId, role: 'assistant', createdAt: Date.now(), parts: [] };
    return insertSorted(messages, update(placeholder));
  }
  const updated = update(messages[i]);
  if (updated === messages[i]) return messages;
  const next = messages.slice();
  next[i] = updated;
  return next;
}

function insertSorted(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = messages.slice();
  let i = next.length;
  while (i > 0 && next[i - 1].createdAt > message.createdAt) i--;
  next.splice(i, 0, message);
  return next;
}

/** Plain-text rendering of a message (export, copy, titles). */
export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}
