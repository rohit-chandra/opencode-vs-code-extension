import { describe, expect, it } from 'vitest';
import { LineSplitter, SseParser } from '../../src/core/sse';

describe('SseParser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const raw = 'event: a\ndata: {"x":1}\n\ndata: line1\ndata: line2\n\n: comment\ndata: last\n\n';
    for (let size = 1; size <= raw.length; size++) {
      const p = new SseParser();
      const out = [];
      for (let i = 0; i < raw.length; i += size) out.push(...p.push(raw.slice(i, i + size)));
      expect(out).toEqual([
        { event: 'a', data: '{"x":1}', id: undefined },
        { event: undefined, data: 'line1\nline2', id: undefined },
        { event: undefined, data: 'last', id: undefined },
      ]);
    }
  });

  it('handles CRLF line endings, including a CR/LF pair split across chunks', () => {
    const p = new SseParser();
    const out = [...p.push('data: one\r'), ...p.push('\n\r\ndata: two\r\n\r\n')];
    expect(out.map((m) => m.data)).toEqual(['one', 'two']);
  });

  it('flushes an unterminated trailing event on end()', () => {
    const p = new SseParser();
    expect(p.push('data: tail')).toEqual([]);
    expect(p.end().map((m) => m.data)).toEqual(['tail']);
  });

  it('keeps a single leading space out of the value but preserves the rest', () => {
    const p = new SseParser();
    expect(p.push('data:  two spaces\n\n')[0].data).toBe(' two spaces');
  });
});

describe('LineSplitter', () => {
  it('yields complete lines and keeps the remainder', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\r\n')).toEqual(['{"b":2}']);
    expect(s.end()).toEqual([]);
    s.push('partial');
    expect(s.end()).toEqual(['partial']);
  });
});
