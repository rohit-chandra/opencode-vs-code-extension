import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/core/engine';
import { UsageLedger } from '../../src/core/usageLedger';
import { ClaudeCodeEngine } from '../../src/engines/cli/claudeCode';
import type { EngineId } from '../../src/shared/types';
import { ChatController } from '../../src/ui/controller';
import { MemoryStore, makeContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { FakeHost } from '../helpers/fakeHost';

/**
 * Signing in to Claude Code with a subscription, and the models that follow. The real CLI
 * cannot sign in to an account in a test, so a stand-in CLI answers the three things the
 * extension asks it (`--version`, `auth status --json`, the SDK `initialize` request) from a
 * file the test rewrites, the way a real sign-in changes what the real CLI answers.
 */

const FAKE = path.resolve(__dirname, '../fixtures/fake-claude.mjs');
const entry = (value: string, displayName: string, description: string) => ({ value, displayName, description });
/** What the CLI reports before it knows the account's plan. */
const GENERIC = [entry('default', 'Default (recommended)', 'Use the default model (currently Sonnet 5.5) · $2/$10 per Mtok'), entry('sonnet', 'Sonnet', 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok'), entry('haiku', 'Haiku', 'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok')];
/** What it reports once it knows the plan. */
const MAX_PLAN = [
  entry('default', 'Default (recommended)', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok'),
  entry('opus', 'Opus', 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'),
  entry('fable', 'Fable', 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok'),
  entry('sonnet', 'Sonnet', 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok'),
  entry('haiku', 'Haiku', 'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok'),
  entry('claude-opus-5', 'Opus 5', 'Opus 5 · Previous Opus version'),
];

describe('Claude Code: signing in with a subscription and the models that follow', () => {
  let ctx: TestContext;
  let host: FakeHost;
  let controller: ChatController;
  let stateFile: string;
  const set = (state: object) => writeFileSync(stateFile, JSON.stringify(state));
  /** How many times the extension has asked the CLI for its models. */
  const listings = () => (existsSync(`${stateFile}.log`) ? readFileSync(`${stateFile}.log`, 'utf8').trim().split('\n').length : 0);
  const names = () => host.view!.providers.flatMap((p) => p.models).map((m) => m.name);
  const ids = () => host.view!.providers.flatMap((p) => p.models).map((m) => m.modelId);

  beforeAll(async () => {
    ctx = makeContext();
    stateFile = path.join(ctx.dir, 'fake-claude.json');
    // A launcher the engine can start like the real CLI, on every platform.
    const launcher = path.join(ctx.dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(launcher, process.platform === 'win32' ? `@"${process.execPath}" "${FAKE}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    if (process.platform !== 'win32') chmodSync(launcher, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, FAKE_CLAUDE_STATE: stateFile };
    for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_)/.test(k)) delete env[k];
    ctx.env = env;
    ctx.settings.defaultEngine = 'claude-code';
    ctx.settings['claudeCode.path'] = launcher;
    set({ loggedIn: false, models: GENERIC });
    host = new FakeHost(ctx);
    controller = new ChatController(new Map<EngineId, Engine>([['claude-code', new ClaudeCodeEngine(ctx)]]), new UsageLedger(new MemoryStore()), host);
    controller.relistAgainMs = 1500;
    await controller.handleMessage({ type: 'ready' });
    await controller.activate();
  });

  afterAll(() => {
    controller?.dispose();
    ctx?.cleanup();
  });

  it('before sign-in: what the CLI reports, plus the Claude models it leaves out', async () => {
    const v = await host.until((x) => x.engine === 'claude-code' && x.providers.length > 0 && x.auth?.signedIn === false, 20_000, 'signed-out state');
    expect(v.auth).toMatchObject({ signedIn: false, mode: 'subscription' });
    expect(names().slice(0, 3)).toEqual(['Default (Sonnet 5.5)', 'Sonnet 5.5', 'Haiku 5.5']);
    // Every family can be picked even when the CLI's list leaves it out, and Opus Plan Mode too.
    expect(ids()).toEqual(['default', 'sonnet', 'haiku', 'fable', 'opus', 'opusplan']);
    expect(names()).toEqual(expect.arrayContaining(['Fable (latest)', 'Opus (latest)', 'Opus Plan Mode']));
  });

  it('after signing in from the chat, the list follows the plan, even when the CLI learns the plan a moment later', async () => {
    await controller.signIn(false);
    expect(host.terminals.at(-1)!.command).toMatch(/auth login --claudeai$/);
    expect(host.view!.auth?.pending).toBe(true);
    // The browser sign-in finishes. For a moment the CLI still reports the generic list.
    const asked = listings();
    set({ loggedIn: true, email: 'dev@example.com', subscriptionType: 'max', models: GENERIC });
    const signedIn = await host.until((x) => x.auth?.signedIn === true && !x.auth.pending, 20_000, 'sign-in noticed');
    expect(signedIn.auth!.label).toBe('Claude account · Max · dev@example.com');
    // The extension lists the models straight away, and gets that generic list.
    await host.until(() => listings() > asked, 20_000, 'models listed after the sign-in');
    expect(names()).not.toContain('Fable 5.2');
    // Only then does the CLI know the plan. The list must still catch up by itself.
    set({ loggedIn: true, email: 'dev@example.com', subscriptionType: 'max', models: MAX_PLAN });
    await host.until((x) => x.providers.flatMap((p) => p.models).some((m) => m.name === 'Fable 5.2'), 20_000, 'the plan\'s models');
    expect(names().slice(0, 6)).toEqual(['Default (Opus 5.5)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Opus 5']);
    // Everything the CLI reported is there, nothing twice, and the extra entry follows.
    expect(ids()).toEqual(['default', 'opus', 'fable', 'sonnet', 'haiku', 'claude-opus-5', 'opusplan']);
  });

  it('notices a sign-in made outside the chat when the window gets the focus back', async () => {
    // `claude auth logout` in a terminal, then another account with another plan.
    set({ loggedIn: false, models: GENERIC });
    controller.onShown();
    await host.until((x) => x.auth?.signedIn === false, 20_000, 'sign-out noticed');
    await host.until(() => ids().join() === 'default,sonnet,haiku,fable,opus,opusplan', 20_000, 'signed-out list');

    set({ loggedIn: true, email: 'other@example.com', subscriptionType: 'pro', models: MAX_PLAN.slice(0, 4) });
    // Asked again too soon: checks are spaced out, so a burst of focus events costs nothing.
    controller.onShown();
    expect(host.view!.auth?.signedIn).toBe(false);
    await new Promise((r) => setTimeout(r, 10_500));
    controller.onShown();
    const v = await host.until((x) => x.auth?.signedIn === true, 20_000, 'sign-in noticed');
    expect(v.auth!.label).toBe('Claude account · Pro · other@example.com');
    await host.until(() => names().includes('Fable 5.2'), 20_000, 'the other plan\'s models');
    expect(ids()).toEqual(['default', 'opus', 'fable', 'sonnet', 'haiku', 'opusplan']);
  }, 60_000);

  it('adds any other model by name, selects it and keeps it in settings', async () => {
    host.inputs.push('not a model name');
    await controller.handleMessage({ type: 'addModel' });
    expect(host.view!.notice?.text).toMatch(/no spaces/);
    expect(ctx.settings['claudeCode.models']).toBeUndefined();

    host.inputs.push('  claude-sonnet-4-6 ');
    await controller.handleMessage({ type: 'addModel' });
    expect(ctx.settings['claudeCode.models']).toEqual(['claude-sonnet-4-6']);
    expect(ids().at(-1)).toBe('claude-sonnet-4-6');
    expect(host.view!.model).toEqual({ providerId: 'claude-code', modelId: 'claude-sonnet-4-6' });
    // Adding it again does not list it twice.
    host.inputs.push('claude-sonnet-4-6');
    await controller.handleMessage({ type: 'addModel' });
    expect(ctx.settings['claudeCode.models']).toEqual(['claude-sonnet-4-6']);
    expect(ids().filter((id) => id === 'claude-sonnet-4-6')).toHaveLength(1);
  });
});
