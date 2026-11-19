import { describe, expect, it } from 'vitest';
import { MAX_ISSUE_URL, buildIssueUrl, diagnosticsMarkdown, feedbackKind, feedbackTitle, repoSlug } from '../../src/shared/feedback';
import type { EnvironmentInfo } from '../../src/shared/feedback';

const env: EnvironmentInfo = { extensionVersion: '0.5.0', editor: 'Visual Studio Code 1.106.0', ui: 'desktop', platform: 'darwin', arch: 'arm64', osRelease: '25.1.0' };

describe('feedback', () => {
  it('finds the GitHub repository in every form package.json allows', () => {
    expect(repoSlug('https://github.com/rohit-chandra/opencode-vs-code-extension.git')).toBe('rohit-chandra/opencode-vs-code-extension');
    expect(repoSlug('https://github.com/a/b')).toBe('a/b');
    expect(repoSlug('https://github.com/a/b/')).toBe('a/b');
    expect(repoSlug('git+https://github.com/a/b.git')).toBe('a/b');
    expect(repoSlug('git@github.com:a/b.git')).toBe('a/b');
    expect(repoSlug('https://gitlab.com/a/b')).toBeUndefined();
    expect(repoSlug(undefined)).toBeUndefined();
  });

  it('falls back to the bug form for an unknown kind', () => {
    expect(feedbackKind('idea')).toBe('idea');
    expect(feedbackKind('other')).toBe('other');
    expect(feedbackKind('bug')).toBe('bug');
    expect(feedbackKind('<script>')).toBe('bug');
    expect(feedbackKind(undefined)).toBe('bug');
  });

  it('titles the issue from the title, or the first line of the details', () => {
    expect(feedbackTitle({ kind: 'bug', title: '  Codex   never answers ', description: 'x' })).toBe('Bug: Codex never answers');
    expect(feedbackTitle({ kind: 'idea', title: '', description: '\n\nA dark Oki\nwith a cape' })).toBe('Idea: A dark Oki');
    expect(feedbackTitle({ kind: 'other', title: '', description: '' })).toBe('');
    const long = feedbackTitle({ kind: 'bug', title: 'x'.repeat(200), description: '' });
    expect(long.length).toBeLessThanOrEqual(95);
    expect(long.endsWith('…')).toBe(true);
  });

  it('builds a link to the right issue form with the fields filled in', () => {
    const url = new URL(buildIssueUrl('a/b', { kind: 'bug', title: 'Sad Oki', description: 'Steps:\n1. open & close\n2. 100% "broken"', diagnostics: '- OS: macOS' }));
    expect(url.origin + url.pathname).toBe('https://github.com/a/b/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('title')).toBe('Bug: Sad Oki');
    expect(url.searchParams.get('description')).toBe('Steps:\n1. open & close\n2. 100% "broken"');
    expect(url.searchParams.get('diagnostics')).toBe('- OS: macOS');
    expect(new URL(buildIssueUrl('a/b', { kind: 'idea', title: '', description: 'x' })).searchParams.get('template')).toBe('feature_request.yml');
    const other = new URL(buildIssueUrl('a/b', { kind: 'other', title: '', description: 'x' }));
    expect(other.searchParams.get('template')).toBe('feedback.yml');
    expect(other.searchParams.has('diagnostics')).toBe(false);
  });

  it('cuts very long details so the link stays valid, and says so', () => {
    for (const text of ['word '.repeat(5000), '日本語のテキスト'.repeat(2000), '%&#?'.repeat(4000)]) {
      const link = buildIssueUrl('a/b', { kind: 'bug', title: 'Long', description: text, diagnostics: '- OS: Linux x64' });
      expect(link.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
      const url = new URL(link);
      expect(url.searchParams.get('description')).toMatch(/cut to fit the link/);
      expect(url.searchParams.get('diagnostics')).toBe('- OS: Linux x64');
      expect(url.searchParams.get('title')).toBe('Bug: Long');
    }
  });

  it('describes the setup without anything personal', () => {
    const text = diagnosticsMarkdown({
      env: { ...env, remote: 'ssh-remote' },
      engine: 'claude-code',
      engines: [
        { engine: 'opencode', state: 'unavailable', detail: 'Not found in /Users/alice/.opencode/bin' },
        { engine: 'claude-code', state: 'ready', version: '2.1.300', detail: '/Users/alice/.local/bin/claude' },
      ],
      model: { providerId: 'claude-code', modelId: 'sonnet' },
      approvals: 'ask',
      avatar: { enabled: true, style: 'buddy', renderer: 'webgl' },
      trusted: true,
    });
    expect(text).toContain('- OpenCode Hub: 0.5.0');
    expect(text).toContain('- Editor: Visual Studio Code 1.106.0 (desktop, remote: ssh-remote)');
    expect(text).toContain('- OS: macOS arm64 (25.1.0)');
    expect(text).toContain('- Engine: Claude Code, ready (2.1.300)');
    expect(text).toContain('- Model: claude-code/sonnet');
    expect(text).toContain('- Other engines: opencode: unavailable');
    // Engine detail text can hold paths with the user's name: it must stay out.
    expect(text).not.toContain('alice');
    expect(text).not.toContain('/Users');
  });
});
