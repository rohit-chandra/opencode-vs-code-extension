import table from './prices.json';

/**
 * List prices for estimating what a reply costs when the engine reports tokens but no cost
 * (Codex, and Direct BYOK providers that do not return one). The table is bundled with the
 * extension and refreshed with `npm run prices`; nothing is downloaded at run time.
 *
 * An estimate is what the tokens would cost at the provider's public API price. With a
 * subscription (a ChatGPT plan in Codex) you are not billed per token, so read it as the
 * API-equivalent value of the session.
 */
export interface Pricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const PRICES = (table as { prices: Record<string, Record<string, number[]>> }).prices;
export const PRICES_UPDATED = (table as { updated: string }).updated;

/** API hosts of the providers in the table. A custom endpoint is never matched by its name alone. */
const HOSTS: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  'api.deepseek.com': 'deepseek',
  'api.x.ai': 'xai',
  'api.together.xyz': 'togetherai',
  'api.together.ai': 'togetherai',
  'router.huggingface.co': 'huggingface',
};

/** Which provider's price list applies to an API base URL, if any. */
export function catalogProviderFor(baseUrl: string): string | undefined {
  try {
    return HOSTS[new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    return undefined;
  }
}

/** Every model id the table has for a provider (the catalogue the weekly price refresh keeps current). */
export function listedModels(provider: string): string[] {
  return Object.keys(PRICES[provider] ?? {});
}

function row(values: number[] | undefined): Pricing | undefined {
  if (!values) return undefined;
  const [input = 0, output = 0, cacheRead, cacheWrite] = values;
  return { input, output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}) };
}

/**
 * Price of a model at a provider. Tolerates the usual decorations of a model id: letter
 * case, a Hugging Face routing suffix (`:fastest`), a date stamp (`-20251001`,
 * `-2025-08-07`) and `-latest`. Returns undefined for anything it does not know: no price
 * is better than a wrong one.
 */
export function listPrice(provider: string | undefined, modelId: string): Pricing | undefined {
  const models = provider ? PRICES[provider] : undefined;
  if (!models || !modelId) return undefined;
  if (models[modelId]) return row(models[modelId]);
  const byLower = new Map(Object.keys(models).map((k) => [k.toLowerCase(), k]));
  const base = modelId.toLowerCase().replace(/:[\w.-]+$/, '');
  const candidates = [base, base.replace(/-latest$/, ''), base.replace(/-\d{8}$/, ''), base.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  for (const c of candidates) {
    const key = byLower.get(c);
    if (key) return row(models[key]);
  }
  return undefined;
}
