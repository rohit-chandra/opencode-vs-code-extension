import type { EngineId, EngineStatus, ModelRef } from './types';
import { ENGINE_LABELS } from './types';

/**
 * Feedback goes to the project's GitHub issues, through the user's own browser and GitHub
 * account. The extension only builds a link to a pre-filled issue form: nothing is sent
 * until the user presses Submit on GitHub, and no token or server of ours is involved.
 */

export type FeedbackKind = 'bug' | 'idea' | 'other';

export const FEEDBACK_KINDS: Record<FeedbackKind, { label: string; template: string; titlePrefix: string }> = {
  bug: { label: 'Something is broken', template: 'bug_report.yml', titlePrefix: 'Bug: ' },
  idea: { label: 'An idea or request', template: 'feature_request.yml', titlePrefix: 'Idea: ' },
  other: { label: 'Other feedback', template: 'feedback.yml', titlePrefix: 'Feedback: ' },
};

export function feedbackKind(value: unknown): FeedbackKind {
  return value === 'idea' || value === 'other' ? value : 'bug';
}

/** GitHub rejects very long request URLs (about 8 kB); stay well below that. */
export const MAX_ISSUE_URL = 7000;

/** `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo.git` to `owner/repo`. */
export function repoSlug(repositoryUrl: string | undefined): string | undefined {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec((repositoryUrl ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** Markdown from `diagnosticsMarkdown`, or empty when the user left it out. */
  diagnostics?: string;
}

/** First line of the description as the issue title, when the user gave none. */
export function feedbackTitle(input: Pick<FeedbackInput, 'kind' | 'title' | 'description'>): string {
  const own = input.title.replace(/\s+/g, ' ').trim();
  const fallback = input.description.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const text = own || fallback;
  const short = text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
  return short ? `${FEEDBACK_KINDS[input.kind].titlePrefix}${short}` : '';
}

/**
 * Link to a pre-filled issue form. The field names (`description`, `diagnostics`) are the
 * ids in `.github/ISSUE_TEMPLATE/*.yml`. Long text is cut so the link stays valid; the form
 * is editable, so the user can paste the rest.
 */
export function buildIssueUrl(slug: string, input: FeedbackInput): string {
  const base = `https://github.com/${slug}/issues/new`;
  const title = feedbackTitle(input);
  const diagnostics = (input.diagnostics ?? '').trim();
  const make = (description: string): string => {
    const q = new URLSearchParams({ template: FEEDBACK_KINDS[input.kind].template });
    if (title) q.set('title', title);
    if (description) q.set('description', description);
    if (diagnostics) q.set('diagnostics', diagnostics);
    return `${base}?${q.toString()}`;
  };
  const full = input.description.trim();
  const note = '\n\n(cut to fit the link: paste the rest here)';
  let keep = full.length;
  let url = make(full);
  // Encoded length is what counts, and it depends on the characters; shrink until it fits.
  while (url.length > MAX_ISSUE_URL && keep > 0) {
    keep = Math.floor(keep * 0.8) - 1;
    url = make(keep > 0 ? full.slice(0, keep).trimEnd() + note : '');
  }
  return url;
}

/** Where the extension is running. No paths, user names, prompts or keys. */
export interface EnvironmentInfo {
  extensionVersion: string;
  /** Editor name and version, e.g. "Visual Studio Code 1.106.2". */
  editor: string;
  /** `desktop` or `web`. */
  ui: string;
  /** Remote kind (`ssh-remote`, `wsl`, `dev-container`, …) or undefined when local. */
  remote?: string;
  platform: string;
  arch: string;
  osRelease: string;
}

const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function osLabel(env: Pick<EnvironmentInfo, 'platform' | 'arch' | 'osRelease'>): string {
  return `${OS_NAMES[env.platform] ?? env.platform} ${env.arch} (${env.osRelease})`;
}

export interface DiagnosticsInput {
  env: EnvironmentInfo;
  engine: EngineId;
  engines: EngineStatus[];
  model: ModelRef | undefined;
  approvals: string;
  avatar: { enabled: boolean; style: string; renderer?: string };
  trusted: boolean;
}

/**
 * What a bug report needs to be reproducible, and nothing personal: versions, the operating
 * system and which engines are available. Engine detail text is left out on purpose because
 * it can contain file paths.
 */
export function diagnosticsMarkdown(d: DiagnosticsInput): string {
  const state = (s: EngineStatus) => `${s.state}${s.version ? ` (${s.version})` : ''}`;
  const active = d.engines.find((e) => e.engine === d.engine);
  const others = d.engines.filter((e) => e.engine !== d.engine).map((e) => `${ENGINE_LABELS[e.engine]}: ${state(e)}`);
  return [
    `- OpenCode Hub: ${d.env.extensionVersion}`,
    `- Editor: ${d.env.editor} (${d.env.ui}${d.env.remote ? `, remote: ${d.env.remote}` : ''})`,
    `- OS: ${osLabel(d.env)}`,
    `- Engine: ${ENGINE_LABELS[d.engine]}, ${active ? state(active) : 'unknown'}`,
    `- Model: ${d.model ? `${d.model.providerId}/${d.model.modelId}` : 'none selected'}`,
    `- Approvals: ${d.approvals}`,
    `- Companion: ${d.avatar.enabled ? `${d.avatar.style}${d.avatar.renderer ? ` (${d.avatar.renderer})` : ''}` : 'off'}`,
    `- Workspace trusted: ${d.trusted ? 'yes' : 'no'}`,
    ...(others.length ? [`- Other engines: ${others.join('; ')}`] : []),
  ].join('\n');
}
