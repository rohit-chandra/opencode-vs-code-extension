/**
 * HTML previews: a reply can show a report, a diagram or a mock-up drawn in the chat instead
 * of a block of markup. The model writes a fenced code block with the language
 * `html-preview`; the chat renders it (see `webview/src/preview.ts`).
 *
 * `/preview <request>` asks for one. The instructions travel at the end of the message,
 * after a marker, so that they work with every engine; the chat shows the request without
 * them. No `vscode`, no Node.
 */

export const PREVIEW_LANG = 'html-preview';

/** Everything after this line in a user message is instructions the chat added, not text the user typed. */
export const PREVIEW_MARKER = '<!-- opencode-hub: html-preview -->';

const INSTRUCTIONS = [
  `Present the answer as a visual. Reply with one short sentence, then ONE fenced code block whose language is \`${PREVIEW_LANG}\` that holds a self-contained HTML fragment. It is drawn directly in the chat.`,
  'Allowed: HTML, CSS in a <style> element or style attributes, tables, inline SVG (charts, diagrams) and <details> sections.',
  'Not rendered, so leave them out: scripts, forms and inputs, links, and anything loaded from the network (images, fonts, stylesheets).',
  'Follow the editor theme instead of fixed colours: var(--vscode-foreground), var(--vscode-descriptionForeground), var(--vscode-editorWidget-background), var(--vscode-widget-border), and for data var(--vscode-charts-blue), -green, -yellow, -orange, -red, -purple. The background is already the chat\'s own.',
  'It is shown in a narrow side bar: let the layout wrap, use relative widths, give an SVG a viewBox and width="100%".',
].join('\n');

/** The message sent for `/preview <request>`. */
export function previewPrompt(request: string): string {
  return `${request.trim()}\n\n${PREVIEW_MARKER}\n${INSTRUCTIONS}`;
}

/** A user message as the user wrote it, and whether the chat added the preview instructions to it. */
export function splitPreviewPrompt(text: string): { text: string; preview: boolean } {
  const i = text.indexOf(PREVIEW_MARKER);
  return i === -1 ? { text, preview: false } : { text: text.slice(0, i).trimEnd(), preview: true };
}

/** Whether a fenced block's language asks for a rendered preview straight away. */
export function isPreviewLang(lang: string | undefined): boolean {
  return (lang ?? '').trim().split(/\s+/)[0].toLowerCase() === PREVIEW_LANG;
}

/** Code blocks that can be previewed on request (a button in the block's bar). */
export function isPreviewable(lang: string | undefined, code: string): boolean {
  const name = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (name === 'html' || name === 'svg') return true;
  return name === 'xml' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code);
}
