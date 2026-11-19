import { describe, expect, it } from 'vitest';
import { authMode, claudeEnv, codexEnv, parseClaudeAuthStatus, parseCodexLoginStatus, shellExe } from '../../src/engines/cli/auth';

describe('account sign-in helpers', () => {
  it('defaults to the subscription', () => {
    expect(authMode(undefined)).toBe('subscription');
    expect(authMode('nonsense')).toBe('subscription');
    expect(authMode('apiKey')).toBe('apiKey');
  });

  it('keeps API keys in the environment away from Claude Code in subscription mode', () => {
    const env = claudeEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-env', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://x' }, 'subscription', undefined);
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://x' });
  });

  it('passes the stored key to Claude Code in API-key mode, falling back to the environment', () => {
    expect(claudeEnv({ ANTHROPIC_API_KEY: 'sk-env' }, 'apiKey', 'sk-stored').ANTHROPIC_API_KEY).toBe('sk-stored');
    expect(claudeEnv({ ANTHROPIC_API_KEY: 'sk-env' }, 'apiKey', undefined).ANTHROPIC_API_KEY).toBe('sk-env');
    expect(() => claudeEnv({}, 'apiKey', undefined)).toThrow(/\/login/);
  });

  it('keeps CODEX_API_KEY away from Codex in subscription mode and sets it in API-key mode', () => {
    expect(codexEnv({ CODEX_API_KEY: 'sk-env', OPENAI_API_KEY: 'o', MOCK_KEY: 'm' }, 'subscription', undefined)).toEqual({ OPENAI_API_KEY: 'o', MOCK_KEY: 'm' });
    expect(codexEnv({}, 'apiKey', 'sk-stored').CODEX_API_KEY).toBe('sk-stored');
    expect(codexEnv({ OPENAI_API_KEY: 'sk-o' }, 'apiKey', undefined).CODEX_API_KEY).toBe('sk-o');
    expect(() => codexEnv({}, 'apiKey', undefined)).toThrow(/\/login/);
  });

  it('parses `claude auth status --json`', () => {
    expect(parseClaudeAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toEqual({ signedIn: false });
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "me@example.com", "subscriptionType": "max"}')).toEqual({ signedIn: true, billing: 'subscription', label: 'Claude account · Max · me@example.com' });
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "apiKeySource": "ANTHROPIC_API_KEY"}')).toEqual({ signedIn: true, billing: 'apiKey', label: 'API key (ANTHROPIC_API_KEY)' });
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "x", "apiProvider": "bedrock"}')).toEqual({ signedIn: true, label: 'bedrock credentials' });
    expect(parseClaudeAuthStatus('error: unknown command "auth"')).toEqual({ signedIn: undefined });
  });

  it('parses `codex login status`', () => {
    expect(parseCodexLoginStatus('Not logged in', 1)).toEqual({ signedIn: false });
    expect(parseCodexLoginStatus('Logged in using ChatGPT', 0)).toMatchObject({ signedIn: true, billing: 'subscription', label: 'ChatGPT account' });
    expect(parseCodexLoginStatus('WARNING: x\nAPI key configured - sk-test1***34567\n', 0)).toMatchObject({ signedIn: true, billing: 'apiKey' });
    expect(parseCodexLoginStatus('something else', 2)).toEqual({ signedIn: undefined });
  });

  it('quotes executables with spaces for the terminal', () => {
    expect(shellExe('', 'claude')).toBe('claude');
    expect(shellExe('/opt/my tools/claude', 'claude')).toMatch(/"\/opt\/my tools\/claude"$/);
  });
});
