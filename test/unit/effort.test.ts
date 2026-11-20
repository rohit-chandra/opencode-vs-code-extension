import { describe, expect, it } from 'vitest';
import { claudeModelInfo, codexEfforts } from '../../src/engines/cli/modelDiscovery';
import { mapQuestion, variantLevels } from '../../src/engines/opencode/mapping';
import { effortHint, effortLabel, effortShortLabel, isCostlyEffort, matchEffort, resolveEffort, toEffortLevels } from '../../src/shared/effort';

describe('effort levels', () => {
  it('cleans up what an engine reports: valid names, no duplicates, lightest first', () => {
    expect(toEffortLevels(['max', 'low', 'high', 'low', 'medium', 'xhigh'])!.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(toEffortLevels(['high', 'none', 'turbo', 'minimal'])!.map((e) => e.id)).toEqual(['none', 'minimal', 'high', 'turbo']);
    expect(toEffortLevels([{ id: 'low', description: 'Fast' }, 'bad name!', '', { id: 'high' }])).toEqual([{ id: 'low', description: 'Fast' }, { id: 'high' }]);
    expect(toEffortLevels([])).toBeUndefined();
    expect(toEffortLevels(undefined)).toBeUndefined();
  });

  it('names levels the way the picker shows them', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'none', 'ultra', 'turbo'].map(effortLabel)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max', 'Off', 'Ultra', 'Turbo']);
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal', 'thorough'].map(effortShortLabel)).toEqual(['Low', 'Med', 'High', 'XHigh', 'Max', 'Off', 'Min', 'Thoro']);
    expect(effortHint({ id: 'low', description: 'Fast responses with lighter reasoning' })).toBe('Fast responses with lighter reasoning');
    expect(effortHint({ id: 'high' })).toBe('More thorough, slower');
    expect(effortHint({ id: 'turbo' })).toBe('');
    expect(['high', 'xhigh', 'max', 'ultra'].map(isCostlyEffort)).toEqual([false, false, true, true]);
  });

  it('only sends a level the model has', () => {
    const model = { efforts: [{ id: 'low' }, { id: 'high' }] };
    expect(resolveEffort('high', model)).toBe('high');
    expect(resolveEffort('max', model)).toBeUndefined();
    expect(resolveEffort(undefined, model)).toBeUndefined();
    expect(resolveEffort('high', {})).toBeUndefined();
    expect(resolveEffort('high', undefined)).toBeUndefined();
  });

  it('finds a level by what the user typed after /effort', () => {
    const levels = [{ id: 'low' }, { id: 'xhigh' }, { id: 'max' }];
    expect(matchEffort('Extra High', levels)?.id).toBe('xhigh');
    expect(matchEffort('XHIGH', levels)?.id).toBe('xhigh');
    expect(matchEffort(' max ', levels)?.id).toBe('max');
    expect(matchEffort('medium', levels)).toBeUndefined();
    expect(matchEffort('', levels)).toBeUndefined();
  });
});

describe('effort levels reported by the engines', () => {
  it('Claude Code: the levels of each model in the CLI\'s list', () => {
    const base = { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' };
    expect(claudeModelInfo({ ...base, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }).efforts!.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(claudeModelInfo({ ...base, supportsEffort: false, supportedEffortLevels: ['low'] }).efforts).toBeUndefined();
    // An older CLI says nothing about effort: no picker.
    expect(claudeModelInfo(base).efforts).toBeUndefined();
  });

  it('Codex: the levels, their descriptions and the default of each model', () => {
    expect(
      codexEfforts({
        id: 'gpt-x',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
          { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
        ],
        defaultReasoningEffort: 'low',
      }),
    ).toEqual({ efforts: [{ id: 'low', description: 'Fast responses with lighter reasoning' }, { id: 'high', description: 'Greater reasoning depth for complex problems' }], defaultEffort: 'low' });
    expect(codexEfforts({ id: 'gpt-x', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'medium' })).toEqual({ efforts: [{ id: 'low' }] });
    expect(codexEfforts({ id: 'gpt-x' })).toEqual({});
  });

  it('opencode: a model\'s variants, whichever way the server lists them', () => {
    expect(variantLevels({ high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low' }, max: { disabled: true } })!.map((e) => e.id)).toEqual(['low', 'high']);
    expect(variantLevels(['high', { id: 'low' }, { name: 'max' }, { id: 'off', disabled: true }])!.map((e) => e.id)).toEqual(['low', 'high', 'max']);
    expect(variantLevels({})).toBeUndefined();
    expect(variantLevels([])).toBeUndefined();
    expect(variantLevels(undefined)).toBeUndefined();
  });

  it('opencode: a question that only takes its listed options says so', () => {
    const q = mapQuestion({ id: 'que_1', sessionID: 'ses_1', questions: [{ header: 'A', question: 'Pick', options: [{ label: 'x' }], custom: false }, { question: 'Other', options: [], multiple: true }] });
    expect(q.questions[0].custom).toBe(false);
    expect(q.questions[1]).toMatchObject({ question: 'Other', multiple: true });
    expect(q.questions[1].custom).toBeUndefined();
  });
});
