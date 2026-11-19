export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Incremental Server-Sent-Events parser. Feed it decoded text chunks; it returns the
 * messages completed by that chunk. Handles CRLF, multi-line `data:` and comments.
 */
export class SseParser {
  private buffer = '';
  private event: string | undefined;
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (this.buffer[idx] === '\r' && idx === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, idx);
      const nl = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(idx + nl);
      if (line === '') {
        if (this.data.length > 0 || this.event !== undefined) {
          out.push({ event: this.event, data: this.data.join('\n'), id: this.id });
        }
        this.event = undefined;
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      else if (field === 'event') this.event = value;
      else if (field === 'id') this.id = value;
    }
    return out;
  }

  /** Flush a trailing message that was not terminated by a blank line. */
  end(): SseMessage[] {
    const out = this.push('\n\n');
    this.buffer = '';
    return out;
  }
}

/** Iterate the SSE messages of a fetch `Response`. */
export async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const msg of parser.push(decoder.decode(value, { stream: true }))) yield msg;
    }
    for (const msg of parser.end()) yield msg;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Split a stream of bytes into lines (used for JSONL output of CLIs). */
export class LineSplitter {
  private buffer = '';
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    return lines;
  }
  end(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? [rest] : [];
  }
}
