import type { EngineId, ModelRef } from './types';

/**
 * The colour of whoever makes the model you are talking to, so the chat shows at a glance
 * which provider a session is using: Claude orange, OpenAI green, Gemini blue, and so on.
 *
 * The model decides, not the route to it: Claude through Copilot, OpenRouter or opencode is
 * still Claude. When the model id says nothing (an alias such as `default`), the provider
 * and then the engine decide.
 */
export interface ProviderBrand {
  id: string;
  label: string;
  /** Works on dark and light themes; the stylesheet mixes it for subtler uses. */
  color: string;
}

const BRANDS: Record<string, ProviderBrand> = {
  anthropic: { id: 'anthropic', label: 'Anthropic (Claude)', color: '#d97757' },
  openai: { id: 'openai', label: 'OpenAI', color: '#10a37f' },
  google: { id: 'google', label: 'Google (Gemini)', color: '#4285f4' },
  xai: { id: 'xai', label: 'xAI (Grok)', color: '#a3a3a3' },
  mistral: { id: 'mistral', label: 'Mistral', color: '#ffb000' },
  deepseek: { id: 'deepseek', label: 'DeepSeek', color: '#4d6bfe' },
  meta: { id: 'meta', label: 'Meta (Llama)', color: '#0a7cff' },
  qwen: { id: 'qwen', label: 'Qwen', color: '#7c6cf2' },
  moonshot: { id: 'moonshot', label: 'Moonshot (Kimi)', color: '#5b8def' },
  zhipu: { id: 'zhipu', label: 'Z.ai (GLM)', color: '#3b82f6' },
  huggingface: { id: 'huggingface', label: 'Hugging Face', color: '#ffd21e' },
  copilot: { id: 'copilot', label: 'GitHub Copilot', color: '#a371f7' },
  opencode: { id: 'opencode', label: 'opencode', color: '#42e0cf' },
  local: { id: 'local', label: 'Local model', color: '#8b949e' },
};

/** Model id patterns, most specific first. Matched anywhere in `provider/model`. */
const MODEL_PATTERNS: [RegExp, string][] = [
  [/claude|anthropic|\b(opus|sonnet|haiku|fable|mythos)\b/i, 'anthropic'],
  [/gemini|gemma|google/i, 'google'],
  [/grok|x-ai|\bxai\b/i, 'xai'],
  [/deepseek/i, 'deepseek'],
  [/qwen|qwq|alibaba/i, 'qwen'],
  [/llama|meta-llama/i, 'meta'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/i, 'mistral'],
  [/kimi|moonshot/i, 'moonshot'],
  [/\bglm|zhipu|z-ai/i, 'zhipu'],
  [/\bgpt|\bo[1-9](-|$)|openai|codex|chatgpt/i, 'openai'],
];

/** Providers (the first half of a model ref) that say who makes the model. */
const PROVIDERS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  'google-vertex': 'google',
  xai: 'xai',
  mistral: 'mistral',
  deepseek: 'deepseek',
  huggingface: 'huggingface',
  'hf-endpoint': 'huggingface',
  'hf-tgi': 'local',
  ollama: 'local',
  lmstudio: 'local',
  opencode: 'opencode',
  copilot: 'copilot',
  'github-copilot': 'copilot',
};

const ENGINES: Partial<Record<EngineId, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  'vscode-lm': 'copilot',
};

/** The brand of the model in use, or undefined when nothing is known (the theme's accent is used). */
export function providerBrand(engine: EngineId, model: ModelRef | undefined): ProviderBrand | undefined {
  // An engine tied to one vendor wins: Claude Code is Claude whatever alias is picked.
  const fixed = engine === 'claude-code' || engine === 'codex' ? ENGINES[engine] : undefined;
  if (fixed) return BRANDS[fixed];
  if (model) {
    const id = `${model.providerId}/${model.modelId}`;
    for (const [re, brand] of MODEL_PATTERNS) if (re.test(model.modelId)) return BRANDS[brand];
    const byProvider = PROVIDERS[model.providerId.toLowerCase()];
    if (byProvider) return BRANDS[byProvider];
    for (const [re, brand] of MODEL_PATTERNS) if (re.test(id)) return BRANDS[brand];
  }
  const byEngine = ENGINES[engine];
  return byEngine ? BRANDS[byEngine] : undefined;
}
