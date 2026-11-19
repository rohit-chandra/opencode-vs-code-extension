import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked } from 'marked';

const LANGS = { bash, cpp, csharp, css, diff, go, java, javascript, json, markdown: markdownLang, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['c', 'h', 'hpp', 'cc'], { languageName: 'cpp' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function highlight(code: string, lang: string | undefined): string {
  const name = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (name && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch {
      /* fall through to plain text */
    }
  }
  return escapeHtml(code);
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const name = (lang ?? '').trim().split(/\s+/)[0];
      // The toolbar buttons are wired up by event delegation in MessageList (data-action).
      return `<div class="code"><div class="code-bar"><span class="code-lang">${escapeHtml(name || 'text')}</span><span class="code-actions"><button type="button" data-action="insert" title="Insert at cursor">Insert</button><button type="button" data-action="copy" title="Copy code">Copy</button></span></div><pre><code class="hljs">${highlight(text, name)}</code></pre></div>`;
    },
  },
});

// Links never navigate the webview: clicks are intercepted and routed through the host.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('data-href', node.getAttribute('href') ?? '');
    node.removeAttribute('href');
    node.setAttribute('role', 'link');
    node.setAttribute('tabindex', '0');
  }
  // Remote images are blocked by the CSP anyway; drop them so no broken placeholders show.
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    if (!src.startsWith('data:image/')) node.remove();
  }
});

const SANITIZE = {
  ADD_ATTR: ['data-action', 'data-href'],
  FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed', 'video', 'audio', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'onerror', 'onclick'],
};

const cache = new Map<string, string>();
const remember = (key: string, html: string): string => {
  if (cache.size > 1500) cache.clear();
  if (key.length < 20_000) cache.set(key, html);
  return html;
};

export interface MarkdownBlock {
  /** Source text of this top-level block; identical text means identical HTML. */
  raw: string;
  html: string;
}

/**
 * Render model output (untrusted) to sanitized HTML, one entry per top-level block
 * (paragraph, list, code fence, table…).
 *
 * Splitting matters while a reply streams in: only the last block changes, so only its
 * DOM is replaced. Everything above it keeps its nodes, its scroll position and its text
 * selection, and a long answer costs the same per chunk as a short one.
 */
export function renderBlocks(text: string): MarkdownBlock[] {
  let tokens: ReturnType<typeof marked.lexer>;
  try {
    tokens = marked.lexer(closeOpenFence(text));
  } catch {
    return [{ raw: text, html: `<p>${escapeHtml(text)}</p>` }];
  }
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    if (token.type === 'space') continue;
    // Reference-style link definitions live on the token list, so they are part of the cache key.
    const refs = Object.keys(tokens.links).length ? JSON.stringify(tokens.links) : '';
    const key = refs + token.raw;
    let html = cache.get(key);
    if (html === undefined) {
      try {
        const one = Object.assign([token], { links: tokens.links });
        html = DOMPurify.sanitize(marked.parser(one), SANITIZE);
      } catch {
        html = `<p>${escapeHtml(token.raw)}</p>`;
      }
      remember(key, html);
    }
    if (html) blocks.push({ raw: token.raw, html });
  }
  return blocks;
}

/** Render a whole document at once. */
export function renderMarkdown(text: string): string {
  return renderBlocks(text)
    .map((b) => b.html)
    .join('');
}

/** While a reply is streaming, a code fence may still be open; close it so the layout does not jump. */
function closeOpenFence(text: string): string {
  const fences = text.match(/^(```|~~~)/gm);
  return fences && fences.length % 2 === 1 ? `${text}\n${fences[fences.length - 1]}` : text;
}
