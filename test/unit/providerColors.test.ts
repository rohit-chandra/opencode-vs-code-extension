import { describe, expect, it } from 'vitest';
import { providerBrand } from '../../src/shared/providerColors';

const brand = (engine: Parameters<typeof providerBrand>[0], providerId?: string, modelId?: string) => providerBrand(engine, providerId ? { providerId, modelId: modelId ?? '' } : undefined)?.id;

describe('provider colours', () => {
  it('Claude is orange and OpenAI green, whatever the engine or route', () => {
    expect(providerBrand('claude-code', { providerId: 'claude-code', modelId: 'default' })?.color).toBe('#d97757');
    expect(brand('claude-code', 'claude-code', 'sonnet')).toBe('anthropic');
    expect(brand('codex', 'codex', 'default')).toBe('openai');
    expect(brand('codex', 'codex', 'gpt-5.6')).toBe('openai');
    // The same model reached through other engines keeps its maker's colour.
    expect(brand('opencode', 'anthropic', 'claude-sonnet-5-5')).toBe('anthropic');
    expect(brand('direct', 'openrouter', 'anthropic/claude-opus-5-5')).toBe('anthropic');
    expect(brand('vscode-lm', 'copilot', 'claude-sonnet-4')).toBe('anthropic');
    expect(brand('vscode-lm', 'copilot', 'gpt-4.1')).toBe('openai');
    expect(brand('direct', 'openai', 'o3-mini')).toBe('openai');
  });

  it('knows the other common makers', () => {
    expect(brand('direct', 'google', 'gemini-2.5-pro')).toBe('google');
    expect(brand('direct', 'xai', 'grok-4')).toBe('xai');
    expect(brand('direct', 'mistral', 'codestral-latest')).toBe('mistral');
    expect(brand('direct', 'deepseek', 'deepseek-chat')).toBe('deepseek');
    expect(brand('direct', 'huggingface', 'Qwen/Qwen3-Coder-480B-A35B-Instruct')).toBe('qwen');
    expect(brand('direct', 'groq', 'llama-3.3-70b-versatile')).toBe('meta');
    expect(brand('direct', 'openrouter', 'moonshotai/kimi-k2')).toBe('moonshot');
    expect(brand('opencode', 'opencode', 'big-pickle')).toBe('opencode');
  });

  it('falls back to the provider, then the engine, and otherwise stays neutral', () => {
    expect(brand('direct', 'ollama', 'my-finetune')).toBe('local');
    expect(brand('direct', 'huggingface', 'some-org/unknown-model')).toBe('huggingface');
    expect(brand('vscode-lm', 'copilot', 'mystery')).toBe('copilot');
    expect(brand('vscode-lm')).toBe('copilot');
    expect(brand('claude-code')).toBe('anthropic');
    expect(brand('direct', 'my-vllm', 'house-model')).toBeUndefined();
    expect(brand('opencode')).toBeUndefined();
  });
});
