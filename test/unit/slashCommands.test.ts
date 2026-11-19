import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, filterCommands, helpMarkdown, isBuiltin, mergeCommands, parseSlash } from '../../src/core/slashCommands';

describe('parseSlash', () => {
  it('parses a command with and without arguments', () => {
    expect(parseSlash('/new')).toEqual({ name: 'new', args: '' });
    expect(parseSlash('  /model  gpt-5  ')).toEqual({ name: 'model', args: 'gpt-5' });
    expect(parseSlash('/review fix the\nbug')).toEqual({ name: 'review', args: 'fix the\nbug' });
    expect(parseSlash('/mcp:server.tool arg')).toEqual({ name: 'mcp:server.tool', args: 'arg' });
  });

  it('does not treat paths or plain text as commands', () => {
    expect(parseSlash('/usr/bin/env node')).toBeUndefined();
    expect(parseSlash('what does /help do?')).toBeUndefined();
    expect(parseSlash('/')).toBeUndefined();
    expect(parseSlash('/1abc')).toBeUndefined();
  });
});

describe('mergeCommands', () => {
  it('keeps built-ins first and hides engine commands that collide with them', () => {
    const merged = mergeCommands([
      { name: 'init', description: 'guided setup', source: 'engine' },
      { name: 'share', description: 'engine share', source: 'engine' },
      { name: 'pdf', description: 'x'.repeat(500), source: 'skill' },
    ]);
    expect(merged.slice(0, BUILTIN_COMMANDS.length)).toEqual(BUILTIN_COMMANDS);
    expect(merged.filter((c) => c.name === 'share')).toHaveLength(1);
    expect(merged.find((c) => c.name === 'share')!.source).toBe('builtin');
    expect(merged.find((c) => c.name === 'init')!.source).toBe('engine');
    expect(merged.find((c) => c.name === 'pdf')!.description.length).toBeLessThanOrEqual(140);
  });
});

describe('filterCommands', () => {
  const cmds = mergeCommands([{ name: 'review', description: 'review changes', source: 'engine' }]);
  it('ranks exact, prefix, substring and description matches in that order', () => {
    expect(filterCommands(cmds, 'se').map((c) => c.name).slice(0, 1)).toEqual(['sessions']);
    expect(filterCommands(cmds, 'mcp')[0].name).toBe('mcp');
    expect(filterCommands(cmds, 'name').map((c) => c.name)).toContain('rename');
    expect(filterCommands(cmds, 'token').map((c) => c.name)).toContain('usage');
    expect(filterCommands(cmds, 'zzzz')).toEqual([]);
    expect(filterCommands(cmds, '').length).toBe(cmds.length);
  });
});

describe('builtins', () => {
  it('covers the commands the README documents', () => {
    for (const name of ['new', 'sessions', 'model', 'agent', 'engine', 'mcp', 'usage', 'attach', 'compact', 'undo', 'redo', 'share', 'fork', 'rename', 'export', 'providers', 'stop', 'avatar', 'help']) {
      expect(isBuiltin(name), name).toBe(true);
    }
    expect(helpMarkdown(BUILTIN_COMMANDS)).toContain('`/model [name]`');
  });
});
