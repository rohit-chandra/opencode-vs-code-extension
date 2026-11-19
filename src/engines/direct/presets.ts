export type ProviderType = 'openai-compatible' | 'anthropic';

export interface ProviderConfig {
  id: string;
  name?: string;
  type: ProviderType;
  baseUrl?: string;
  models?: string[];
  headers?: Record<string, string>;
  pricing?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
}

export interface ProviderPreset extends ProviderConfig {
  name: string;
  baseUrl: string;
  /** Environment variable that conventionally holds this provider's key. */
  envKey?: string;
  /** Local servers that need no API key. */
  keyless?: boolean;
  description: string;
}

/** Ready-made endpoints for the "add provider" flow. Model lists are discovered from each provider's /models endpoint. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', description: 'GPT models with an OpenAI API key' },
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', description: 'Claude models with an Anthropic API key' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', description: 'Hundreds of hosted and open-source models' },
  { id: 'google', name: 'Google Gemini', type: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY', description: 'Gemini through the OpenAI-compatible endpoint' },
  { id: 'groq', name: 'Groq', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', description: 'Fast inference for open-source models' },
  { id: 'mistral', name: 'Mistral', type: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', description: 'Mistral and Codestral models' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', description: 'DeepSeek chat and reasoner' },
  { id: 'xai', name: 'xAI', type: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', description: 'Grok models' },
  { id: 'together', name: 'Together AI', type: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY', description: 'Hosted open-source models' },
  { id: 'ollama', name: 'Ollama (local)', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', keyless: true, description: 'Open-source models on your machine' },
  { id: 'lmstudio', name: 'LM Studio (local)', type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', keyless: true, description: 'Open-source models on your machine' },
];

export const presetById = (id: string): ProviderPreset | undefined => PROVIDER_PRESETS.find((p) => p.id === id);

export const secretKeyFor = (providerId: string): string => `opencodeHub.apiKey.${providerId}`;

/** Fill a user-configured provider with preset defaults (same id). */
export function resolveProvider(cfg: ProviderConfig): ProviderConfig & { name: string; baseUrl: string; keyless: boolean; envKey?: string } {
  const preset = presetById(cfg.id);
  const baseUrl = cfg.baseUrl?.trim() || preset?.baseUrl || (cfg.type === 'anthropic' ? 'https://api.anthropic.com' : '');
  return {
    ...cfg,
    name: cfg.name || preset?.name || cfg.id,
    baseUrl,
    envKey: preset?.envKey,
    keyless: preset?.keyless ?? /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(baseUrl),
  };
}
