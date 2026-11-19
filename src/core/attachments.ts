import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Attachment } from '../shared/types';

const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function mimeForPath(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  if (ext === '.pdf') return 'application/pdf';
  return 'text/plain';
}

export const isImageMime = (mime: string): boolean => mime.startsWith('image/');

export interface ResolvedAttachment {
  attachment: Attachment;
  /** Text to inline into the prompt (files, selections). */
  text?: string;
  /** Base64 image payload. */
  image?: { mime: string; data: string };
  note?: string;
}

/**
 * Load attachment contents for engines that need the bytes in the request itself
 * (direct BYOK, VS Code LM). Engines with file access of their own only get paths.
 */
export async function resolveAttachment(a: Attachment): Promise<ResolvedAttachment> {
  if (a.dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(a.dataUrl);
    if (m && isImageMime(m[1] ?? a.mime)) return { attachment: a, image: { mime: m[1] ?? a.mime, data: m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), 'utf8').toString('base64') } };
    if (m) return { attachment: a, text: m[2] ? Buffer.from(m[3], 'base64').toString('utf8') : decodeURIComponent(m[3]) };
  }
  if (a.text !== undefined) return { attachment: a, text: a.text };
  if (!a.path) return { attachment: a, note: `(attachment ${a.name} has no content)` };
  try {
    const st = await fs.stat(a.path);
    if (st.isDirectory()) {
      const names = (await fs.readdir(a.path)).slice(0, 200);
      return { attachment: a, text: names.join('\n'), note: 'directory listing' };
    }
    if (isImageMime(a.mime)) {
      if (st.size > MAX_IMAGE_BYTES) return { attachment: a, note: `(image ${a.name} is larger than 5 MB and was skipped)` };
      return { attachment: a, image: { mime: a.mime, data: (await fs.readFile(a.path)).toString('base64') } };
    }
    const buf = await fs.readFile(a.path);
    if (looksBinary(buf)) return { attachment: a, note: `(binary file ${a.name} was skipped)` };
    let text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
    if (a.range) {
      text = text
        .split(/\r?\n/)
        .slice(a.range.startLine - 1, a.range.endLine)
        .join('\n');
    } else if (buf.length > MAX_TEXT_BYTES) {
      text += `\n… (truncated, ${buf.length - MAX_TEXT_BYTES} more bytes)`;
    }
    return { attachment: a, text };
  } catch (err) {
    return { attachment: a, note: `(could not read ${a.name}: ${err instanceof Error ? err.message : String(err)})` };
  }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Render resolved text attachments as fenced context blocks appended to the user prompt. */
export function attachmentsAsText(resolved: ResolvedAttachment[]): string {
  const blocks: string[] = [];
  for (const r of resolved) {
    if (r.text !== undefined) blocks.push(`<attachment name="${r.attachment.name}">\n${r.text}\n</attachment>`);
    else if (r.note) blocks.push(r.note);
  }
  return blocks.join('\n\n');
}
