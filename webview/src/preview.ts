import DOMPurify from 'dompurify';

/**
 * Draws model-written HTML inside the chat.
 *
 * Model output is untrusted, so the markup is not simply inserted:
 *
 *  - DOMPurify removes scripts, event handlers, forms, frames and embedded media. Links lose
 *    their target (the shared hook in `markdown.ts`) and images survive only as data: URLs.
 *  - It is drawn in a shadow root, so its CSS cannot restyle the chat.
 *  - The host element contains layout and paint (`contain: content` in the stylesheet), so a
 *    `position: fixed` element cannot leave the preview's box to sit on top of the chat's own
 *    buttons.
 *  - Nothing is fetched: the webview's content security policy allows no remote images,
 *    styles or fonts, and `@import` and remote `url()` are dropped from the CSS as well.
 */

const PREVIEW_SANITIZE = {
  FORCE_BODY: true,
  ADD_TAGS: ['style'],
  ADD_ATTR: ['data-href'],
  FORBID_TAGS: ['script', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta', 'base', 'dialog'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'action', 'autofocus', 'contenteditable'],
};

/** Theme defaults inside the preview, so plain markup already looks like part of the chat. */
const BASE_CSS = `
:host { display: block; }
.ohp-body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: inherit; line-height: 1.5; overflow-wrap: anywhere; }
.ohp-body * { box-sizing: border-box; max-width: 100%; }
.ohp-body table { border-collapse: collapse; }
.ohp-body th, .ohp-body td { padding: 4px 8px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); text-align: left; }
.ohp-body svg { height: auto; }
.ohp-body [data-href] { color: var(--vscode-textLink-foreground); text-decoration: underline; cursor: default; }
.ohp-body details > summary { cursor: pointer; }
`;

/**
 * Make a stylesheet written for a whole page work inside the preview: `html`, `body` and
 * `:root` mean the preview's own box, nothing is imported, and nothing remote is referenced.
 */
export function scopeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:|#)[^)]*\)/gi, 'none')
    .replace(/(^|[\s,}>+~])(?:html|body|:root)(?=\s*[\s,{.:#[>+~])/gi, '$1.ohp-body');
}

/** The markup as it will be drawn: sanitized, with its stylesheets scoped. */
export function sanitizePreview(source: string): string {
  const clean = DOMPurify.sanitize(source, PREVIEW_SANITIZE);
  const box = document.createElement('template');
  box.innerHTML = clean;
  for (const style of [...box.content.querySelectorAll('style')]) style.textContent = scopeCss(style.textContent ?? '');
  for (const el of [...box.content.querySelectorAll<HTMLElement>('[style]')]) {
    const value = el.getAttribute('style') ?? '';
    if (/url\(|expression\(|@import/i.test(value)) el.setAttribute('style', scopeCss(value));
  }
  return box.innerHTML;
}

/** Draw `source` into `host` (replacing what it showed before). */
export function mountPreview(host: HTMLElement, source: string): void {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${BASE_CSS}</style><div class="ohp-body">${sanitizePreview(source)}</div>`;
}

/**
 * A self-contained HTML file of a preview, for "Save HTML": the sanitized markup with the
 * theme colours it used written out, so it looks the same outside the editor.
 */
export function standaloneHtml(source: string, title = 'Preview'): string {
  const body = sanitizePreview(source);
  const names = new Set<string>();
  for (const m of body.matchAll(/var\(\s*(--vscode-[\w-]+)/g)) names.add(m[1]);
  for (const n of ['--vscode-foreground', '--vscode-editor-background', '--vscode-font-family', '--vscode-widget-border', '--vscode-textLink-foreground']) names.add(n);
  // VS Code sets the theme variables on the page's root; the body inherits them (and has them in the tests).
  const computed = getComputedStyle(document.body);
  const vars = [...names].map((n) => [n, computed.getPropertyValue(n).trim()] as const).filter(([, v]) => v);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
:root { ${vars.map(([n, v]) => `${n}: ${v};`).join(' ')} }
body { margin: 24px auto; max-width: 960px; padding: 0 16px; background: var(--vscode-editor-background); }
${BASE_CSS.replace(':host { display: block; }', '')}
</style>
</head>
<body>
<div class="ohp-body">${body}</div>
</body>
</html>
`;
}

/**
 * Turn the previewable code blocks inside `container` into previews. A block marked
 * `data-preview="auto"` is drawn at once (and its source tucked away); one marked `manual`
 * waits for its Preview button. A block still being written (`data-open`) is left as code.
 */
export function mountPreviews(container: HTMLElement): void {
  for (const block of container.querySelectorAll<HTMLElement>('.code[data-preview="auto"]:not([data-open])')) showPreview(block, true);
}

/** Show or hide the preview of one code block. */
export function showPreview(block: HTMLElement, on: boolean): void {
  let host = block.querySelector<HTMLElement>(':scope > .preview-host');
  if (on && !host) {
    host = document.createElement('div');
    host.className = 'preview-host';
    block.insertBefore(host, block.querySelector('pre'));
  }
  if (on && host) mountPreview(host, block.querySelector('code')?.textContent ?? '');
  block.classList.toggle('previewing', on);
  const button = block.querySelector<HTMLElement>('[data-action="preview"]');
  if (button) button.textContent = on ? 'Source' : 'Preview';
}
