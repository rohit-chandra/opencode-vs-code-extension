import type { AuthMode, AuthStatus, EngineId } from '../../shared/types';

/**
 * Account sign-in for the Claude Code and Codex engines.
 *
 * Both CLIs can bill a Claude / ChatGPT subscription or an API key. An API key in the
 * environment (often set for other tools) silently wins over the subscription login, and
 * per-token billing is far more expensive, so in `subscription` mode those variables are
 * removed from the CLI's environment. In `apiKey` mode the key from VS Code Secret Storage
 * (or, failing that, the environment) is passed explicitly.
 */

/** Variables that make Claude Code bill an API key instead of the Claude account. */
export const CLAUDE_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
/** Variable that makes `codex exec` bill an API key instead of the ChatGPT login. */
export const CODEX_KEY_VARS = ['CODEX_API_KEY'] as const;

export function authMode(value: unknown): AuthMode {
  return value === 'apiKey' ? 'apiKey' : 'subscription';
}

export const apiKeySecret = (engine: EngineId): string => `opencodeHub.apiKey.${engine}`;

/** Environment for a Claude Code run. Throws when API-key mode has no key. */
export function claudeEnv(base: NodeJS.ProcessEnv, mode: AuthMode, storedKey: string | undefined): NodeJS.ProcessEnv {
  const env = { ...base };
  if (mode === 'subscription') {
    for (const k of CLAUDE_KEY_VARS) delete env[k];
    return env;
  }
  const key = storedKey || base.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Claude Code is set to use an API key, but none is stored. Use /login to add one or to sign in with your Claude account.');
  env.ANTHROPIC_API_KEY = key;
  return env;
}

/** Environment for a Codex run. Throws when API-key mode has no key. */
export function codexEnv(base: NodeJS.ProcessEnv, mode: AuthMode, storedKey: string | undefined): NodeJS.ProcessEnv {
  const env = { ...base };
  if (mode === 'subscription') {
    for (const k of CODEX_KEY_VARS) delete env[k];
    return env;
  }
  const key = storedKey || base.CODEX_API_KEY || base.OPENAI_API_KEY;
  if (!key) throw new Error('Codex is set to use an API key, but none is stored. Use /login to add one or to sign in with ChatGPT.');
  env.CODEX_API_KEY = key;
  return env;
}

/** First JSON object in a CLI's output (some CLIs print warnings before it). */
function firstJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Parse `claude auth status --json`. */
export function parseClaudeAuthStatus(output: string): Pick<AuthStatus, 'signedIn' | 'billing' | 'label'> {
  const j = firstJson(output);
  if (!j || typeof j.loggedIn !== 'boolean') return { signedIn: undefined };
  if (!j.loggedIn) return { signedIn: false };
  const method = (str(j.authMethod) ?? '').toLowerCase();
  const provider = (str(j.apiProvider) ?? 'firstParty').toLowerCase();
  const email = str(j.email) ?? str(j.emailAddress) ?? str((j.account as Record<string, unknown> | undefined)?.email);
  const plan = str(j.subscriptionType) ?? str(j.planTier) ?? str(j.subscription);
  if (provider !== 'firstparty') {
    // Bedrock, Vertex, Foundry: the user's cloud account. Not a Claude subscription, but not ours to change either.
    return { signedIn: true, label: `${provider} credentials` };
  }
  if (method.includes('api') && method.includes('key')) {
    const source = str(j.apiKeySource);
    return { signedIn: true, billing: 'apiKey', label: `API key${source ? ` (${source})` : ''}` };
  }
  const parts = ['Claude account', plan && cap(plan), email].filter(Boolean);
  return { signedIn: true, billing: method === 'console' ? 'apiKey' : 'subscription', label: parts.join(' · ') };
}

/** Parse `codex login status` (plain text, on stdout or stderr depending on the version). */
export function parseCodexLoginStatus(output: string, exitCode: number | null): Pick<AuthStatus, 'signedIn' | 'billing' | 'label'> {
  const text = output.replace(/\r/g, '');
  if (/not logged in/i.test(text)) return { signedIn: false };
  if (/chatgpt/i.test(text)) {
    const email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(text)?.[0];
    return { signedIn: true, billing: 'subscription', label: ['ChatGPT account', email].filter(Boolean).join(' · ') };
  }
  if (/api key|access token/i.test(text)) return { signedIn: true, billing: 'apiKey', label: 'API key (saved by `codex login`)' };
  if (exitCode === 0 && /logged in/i.test(text)) return { signedIn: true };
  return { signedIn: undefined };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Quote an executable for a terminal command line. Plain names stay as they are. */
export function shellExe(configured: string | undefined, fallback: string): string {
  const exe = configured?.trim() || fallback;
  if (!/\s/.test(exe)) return exe;
  // PowerShell (the default on Windows) runs a quoted path only with the call operator.
  return process.platform === 'win32' ? `& "${exe}"` : `"${exe}"`;
}
