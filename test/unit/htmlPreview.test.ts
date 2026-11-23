import { describe, expect, it } from 'vitest';
import { PREVIEW_MARKER, isPreviewLang, isPreviewable, previewPrompt, splitPreviewPrompt } from '../../src/shared/htmlPreview';

describe('html preview prompts', () => {
  it('adds the instructions after a marker and takes them off again for display', () => {
    const sent = previewPrompt('  chart the build times ');
    expect(sent.startsWith(`chart the build times\n\n${PREVIEW_MARKER}\n`)).toBe(true);
    expect(sent).toMatch(/fenced code block whose language is `html-preview`/);
    expect(sent).toMatch(/scripts, forms and inputs, links, and anything loaded from the network/);
    expect(splitPreviewPrompt(sent)).toEqual({ text: 'chart the build times', preview: true });
    expect(splitPreviewPrompt('an ordinary message')).toEqual({ text: 'an ordinary message', preview: false });
  });

  it('knows which code blocks are drawn at once and which can be previewed on request', () => {
    expect(isPreviewLang('html-preview')).toBe(true);
    expect(isPreviewLang('HTML-Preview title="x"')).toBe(true);
    expect(isPreviewLang('html')).toBe(false);
    expect(isPreviewLang(undefined)).toBe(false);
    expect(isPreviewable('html', '<p>hi</p>')).toBe(true);
    expect(isPreviewable('svg', '<svg/>')).toBe(true);
    expect(isPreviewable('xml', '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>')).toBe(true);
    expect(isPreviewable('xml', '<project></project>')).toBe(false);
    expect(isPreviewable('ts', 'const a = "<svg>"')).toBe(false);
  });
});
