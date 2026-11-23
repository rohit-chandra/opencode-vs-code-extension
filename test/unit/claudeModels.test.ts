import { describe, expect, it } from 'vitest';
import { listedModels } from '../../src/core/listPrices';
import { moreModels } from '../../src/engines/cli/claudeCode';
import { claudeVersions } from '../../src/engines/cli/modelDiscovery';
import type { ModelInfo } from '../../src/shared/types';

const IDS = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-8-fast', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-5-5-fast', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-2-fast', 'claude-3-5-sonnet-20241022', 'gpt-6'];
const catalogue = claudeVersions(IDS);
const model = (modelId: string, name: string, resolvedId?: string): ModelInfo => ({ providerId: 'claude-code', modelId, name, resolvedId });

describe('claudeVersions', () => {
  it('reads released versions off model ids: most capable family first, newest version first', () => {
    expect(catalogue.map((v) => `${v.id}=${v.name}`)).toEqual([
      'claude-fable-5-2=Fable 5.2',
      'claude-opus-5-5=Opus 5.5',
      'claude-opus-5=Opus 5',
      'claude-opus-4-8=Opus 4.8',
      'claude-sonnet-5-5=Sonnet 5.5',
      'claude-sonnet-5=Sonnet 5',
      'claude-haiku-5-5=Haiku 5.5',
      'claude-haiku-4-5=Haiku 4.5',
    ]);
  });

  it('reads a family it has never heard of the same way', () => {
    expect(claudeVersions(['claude-saga-6-1', 'claude-opus-6']).map((v) => v.name)).toEqual(['Opus 6', 'Saga 6.1']);
  });

  it('finds the current Claude models in the catalogue that ships with the extension', () => {
    const names = claudeVersions(listedModels('anthropic')).map((v) => v.name);
    for (const family of ['Fable', 'Opus', 'Sonnet', 'Haiku']) expect(names.some((n) => n.startsWith(`${family} `)), family).toBe(true);
    expect(names.every((n) => /^[A-Z][a-z]+ \d+(\.\d+)?$/.test(n))).toBe(true);
  });
});

describe('moreModels', () => {
  it('adds what the account\'s list leaves out by its real name and full id, never as "latest"', () => {
    // A plan whose list has Sonnet and Haiku only.
    const listed = [model('default', 'Default (Sonnet 5.5)', 'claude-sonnet-5-5'), model('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), model('haiku', 'Haiku 5.5', 'claude-haiku-5-5')];
    const more = moreModels(listed, true, catalogue);
    expect(more.map((m) => `${m.modelId}=${m.name}`)).toEqual(['claude-fable-5-2=Fable 5.2', 'claude-opus-5-5=Opus 5.5', 'opusplan=Opus Plan Mode', 'claude-opus-5=Opus 5', 'claude-opus-4-8=Opus 4.8', 'claude-sonnet-5=Sonnet 5', 'claude-haiku-4-5=Haiku 4.5']);
    expect(more.every((m) => !/latest/i.test(m.name))).toBe(true);
    expect(more[1].description).toMatch(/^Not in the list Claude Code reports for your account/);
    expect(more.find((m) => m.modelId === 'claude-sonnet-5')!.description).toMatch(/^Earlier Sonnet version/);
  });

  it('offers the newest version when an outdated CLI still takes the alias to mean an older one', () => {
    // An old Claude Code resolves `opus` to Opus 5; Opus 5.5 must still be on the list.
    const listed = [model('default', 'Default (Opus 5)', 'claude-opus-5'), model('opus', 'Opus 5', 'claude-opus-5'), model('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), model('haiku', 'Haiku 5.5', 'claude-haiku-5-5'), model('fable', 'Fable 5.2', 'claude-fable-5-2')];
    const more = moreModels(listed, true, catalogue);
    expect(more[0]).toMatchObject({ modelId: 'claude-opus-5-5', name: 'Opus 5.5' });
    expect(more.map((m) => m.modelId)).not.toContain('claude-opus-5');
  });

  it('lists nothing twice when the account already has every newest version', () => {
    const listed = [model('default', 'Default (Opus 5.5)', 'claude-opus-5-5'), model('opus', 'Opus 5.5', 'claude-opus-5-5'), model('fable', 'Fable 5.2', 'claude-fable-5-2'), model('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), model('haiku', 'Haiku 5.5', 'claude-haiku-5-5')];
    expect(moreModels(listed, true, catalogue).map((m) => m.modelId)).toEqual(['opusplan', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('keeps a family\'s alias when no version of it is known, and says what the alias means', () => {
    const more = moreModels([model('default', 'Default')], false, claudeVersions(['claude-opus-5-5']));
    expect(more.map((m) => `${m.modelId}=${m.name}`)).toEqual(['fable=Fable (newest your Claude Code knows)', 'claude-opus-5-5=Opus 5.5', 'sonnet=Sonnet (newest your Claude Code knows)', 'haiku=Haiku (newest your Claude Code knows)', 'opusplan=Opus Plan Mode']);
    // An older CLI reported nothing, so nothing is said about the plan.
    expect(more[1].description).toBe('Newest Opus');
  });
});
