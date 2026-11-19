import { describe, expect, it } from 'vitest';
import { describe as describeTool } from '../../src/engines/cli/claudeApprover';
import { resolveProvider } from '../../src/engines/direct/presets';
import { approvalMode } from '../../src/shared/types';
import { claudeModelInfo } from '../../src/engines/cli/modelDiscovery';
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

describe('approvals and Hugging Face', () => {
  it('defaults to asking', () => {
    expect(approvalMode(undefined)).toBe('ask');
    expect(approvalMode('auto')).toBe('auto');
  });

  it('describes Claude Code tool calls for the approval card', () => {
    expect(describeTool('Bash', { command: 'rm -rf build', description: 'Clean the build' })).toMatchObject({ kind: 'bash', title: 'Run a command: Clean the build', detail: 'rm -rf build' });
    expect(describeTool('Write', { file_path: '/w/a.ts', content: 'x' })).toMatchObject({ title: 'Write /w/a.ts?', detail: 'x' });
    expect(describeTool('mcp__github__create_issue', { title: 't' })).toMatchObject({ kind: 'mcp', title: 'Allow create_issue (github MCP server)?' });
  });

  it('resolves the Hugging Face preset', () => {
    expect(resolveProvider({ id: 'huggingface', type: 'openai-compatible' })).toMatchObject({ name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', keyless: false, envKeys: ['HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'HUGGING_FACE_HUB_TOKEN'] });
    expect(resolveProvider({ id: 'hf-tgi', type: 'openai-compatible' })).toMatchObject({ baseUrl: 'http://localhost:8080/v1', keyless: true });
  });
});

describe('model names from the CLIs', () => {
  it('names Claude Code models by version, without API prices', () => {
    expect(claudeModelInfo({ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok' })).toMatchObject({ modelId: 'default', name: 'Default (Opus 5.5)' });
    expect(claudeModelInfo({ value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok' })).toEqual({ providerId: 'claude-code', modelId: 'fable', name: 'Fable 5.2', description: 'Most capable for your hardest and longest-running tasks', resolvedId: 'claude-fable-5-2', supportsImages: true, supportsTools: true });
    expect(claudeModelInfo({ value: 'claude-x', displayName: 'Claude X' })).toMatchObject({ name: 'Claude X' });
  });
});
