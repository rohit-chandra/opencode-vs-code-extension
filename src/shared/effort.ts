import type { EffortLevel, ModelInfo } from './types';

/** Lightest first. Engines name their levels differently; anything not listed here sorts last, in the order given. */
const ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const LABELS: Record<string, string> = {
  none: 'Off',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

const HINTS: Record<string, string> = {
  none: 'No extra thinking',
  off: 'No extra thinking',
  minimal: 'Fastest, very little thinking',
  low: 'Fast answers with lighter thinking',
  medium: 'Balances speed and depth',
  high: 'More thorough, slower',
  xhigh: 'Deeper thinking for complex problems',
  max: 'Deepest thinking, for the hardest problems',
  ultra: 'Deepest thinking, for the hardest problems',
};

/** Levels that use a plan's limits (or tokens) much faster than the others. */
const COSTLY = new Set(['max', 'ultra']);

export function effortLabel(id: string): string {
  return LABELS[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

const SHORT: Record<string, string> = { none: 'Off', off: 'Off', minimal: 'Min', medium: 'Med', xhigh: 'XHigh' };

/** A label of at most five letters, for where space is tight. */
export function effortShortLabel(id: string): string {
  return SHORT[id.toLowerCase()] ?? effortLabel(id).slice(0, 5);
}

export function effortHint(level: EffortLevel): string {
  return level.description ?? HINTS[level.id.toLowerCase()] ?? '';
}

export function isCostlyEffort(id: string): boolean {
  return COSTLY.has(id.toLowerCase());
}

/** Engine-reported level names as a clean list: valid ids only, no duplicates, lightest first. */
export function toEffortLevels(levels: readonly (string | EffortLevel)[] | undefined): EffortLevel[] | undefined {
  const seen = new Set<string>();
  const out: EffortLevel[] = [];
  for (const raw of levels ?? []) {
    const level = typeof raw === 'string' ? { id: raw } : raw;
    if (!level || typeof level.id !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(level.id) || seen.has(level.id)) continue;
    seen.add(level.id);
    out.push(level.description ? { id: level.id, description: String(level.description) } : { id: level.id });
  }
  if (out.length === 0) return undefined;
  const rank = (id: string) => {
    const i = ORDER.indexOf(id.toLowerCase());
    return i < 0 ? ORDER.length : i;
  };
  return out.map((level, i) => ({ level, i })).sort((a, b) => rank(a.level.id) - rank(b.level.id) || a.i - b.i).map((x) => x.level);
}

/** The level to send for a model: the wanted one when the model has it, otherwise none (the model's default). */
export function resolveEffort(wanted: string | undefined, model: Pick<ModelInfo, 'efforts'> | undefined): string | undefined {
  return wanted && model?.efforts?.some((e) => e.id === wanted) ? wanted : undefined;
}

/** Find a level by what the user typed: its id or its label, any case ("extra high", "xhigh"). */
export function matchEffort(text: string, efforts: readonly EffortLevel[] | undefined): EffortLevel | undefined {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!t) return undefined;
  return efforts?.find((e) => e.id.toLowerCase().replace(/[\s_-]+/g, '') === t || effortLabel(e.id).toLowerCase().replace(/[\s_-]+/g, '') === t);
}
