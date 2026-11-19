import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { OpencodeHubApi } from '../../../src/extension';
import type { ViewState } from '../../../src/shared/protocol';
import type { Part } from '../../../src/shared/types';

const EXTENSION_ID = 'rohit-chandra.opencode-hub';
const hasOpencode = !!process.env.OCHUB_TEST_HAS_OPENCODE;
const mockPort = process.env.OCHUB_TEST_MOCK_PORT;

async function until<T>(what: string, fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const texts = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text);

/** Mocha entry point called by @vscode/test-electron inside the extension host. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 120_000, color: true, reporter: 'spec' });
  const { describe, it, before } = Mocha;
  let api: OpencodeHubApi;
  const state = (): ViewState => api.controller.viewState as ViewState;

  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  describe(`OpenCode Hub in VS Code ${vscode.version}`, () => {
    before(async () => {
      const ext = vscode.extensions.getExtension<OpencodeHubApi>(EXTENSION_ID);
      assert.ok(ext, 'extension is installed');
      api = await ext.activate();
    });

    it('activates and exposes its API', () => {
      assert.ok(api.controller);
      assert.deepEqual([...api.engines.keys()], ['opencode', 'direct', 'claude-code', 'codex', 'vscode-lm']);
    });

    it('registers every contributed command', async () => {
      const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { contributes: { commands: { command: string }[] } };
      const all = new Set(await vscode.commands.getCommands(true));
      const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !all.has(c));
      assert.deepEqual(missing, []);
      assert.ok(pkg.contributes.commands.length >= 15);
    });

    it('has sensible configuration defaults', () => {
      const cfg = vscode.workspace.getConfiguration('opencodeHub');
      assert.equal(cfg.get('defaultEngine'), 'opencode');
      assert.equal(cfg.get('avatar.enabled'), true);
      assert.equal(cfg.get('avatar.style'), 'buddy');
      assert.equal(cfg.get('chat.zoom'), 1);
      assert.deepEqual(cfg.get('providers'), []);
      assert.deepEqual(cfg.get('mcp.servers'), {});
    });

    it('opens the chat view, loads the webview and mounts the 3D companion', async () => {
      await vscode.commands.executeCommand('opencodeHub.focus');
      await until('webview ready', () => api.controller.isWebviewReady, 30_000);
      const renderer = await until('companion mounted', () => api.controller.avatarRenderer, 30_000);
      assert.ok(renderer === 'webgl' || renderer === '2d');
      console.log(`      companion renderer inside VS Code: ${renderer}`);
    });

    it('reports unavailable engines with instructions instead of failing', async () => {
      const claude = await api.engines.get('claude-code')!.start();
      assert.equal(claude.state, 'unavailable');
      assert.match(claude.detail ?? '', /npm i -g @anthropic-ai\/claude-code/);
      const lm = await api.engines.get('vscode-lm')!.start();
      // Copilot is not installed in the test editor; with it installed this engine is "ready".
      if (lm.state === 'unavailable') assert.match(lm.detail ?? '', /GitHub Copilot Chat/);
    });

    it('opens the feedback form with diagnostics of this editor and system', async () => {
      await vscode.commands.executeCommand('opencodeHub.sendFeedback');
      const s = await until('feedback form', () => (state().panel.name === 'feedback' ? state() : undefined), 10_000);
      const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { version: string };
      assert.ok(s.diagnostics.includes(`- OpenCode Hub: ${pkg.version}`), s.diagnostics);
      assert.ok(s.diagnostics.includes(vscode.version), s.diagnostics);
      assert.match(s.diagnostics, /- OS: (macOS|Windows|Linux) \w+ \(/);
      // Diagnostics must not give away where the user's files are.
      assert.ok(!s.diagnostics.includes(vscode.workspace.workspaceFolders![0].uri.fsPath));
      console.log(s.diagnostics.split('\n').map((l) => `      ${l}`).join('\n'));
    });

    it('/doctor lists every engine in the chat', async () => {
      const before = state().messages.length;
      await vscode.commands.executeCommand('opencodeHub.doctor');
      const s = await until('doctor output', () => (state().messages.length > before ? state() : undefined), 10_000);
      const text = texts(s.messages[s.messages.length - 1].parts).join('');
      assert.match(text, /OpenCode Hub doctor/);
      for (const name of ['opencode', 'Direct BYOK', 'Claude Code', 'Codex (ChatGPT)', 'Copilot / VS Code models']) assert.ok(text.includes(`| ${name}`), `missing ${name}`);
    });

    (hasOpencode ? describe : describe.skip)('with the real opencode server', () => {
      before(async () => {
        await until('opencode ready', () => !state().loading && state().engines.find((e) => e.engine === 'opencode')?.state === 'ready', 90_000);
      });

      it('loads models, agents, commands and MCP servers from opencode', () => {
        const s = state();
        assert.deepEqual(s.model, { providerId: 'mock', modelId: 'mock-small' });
        assert.ok(s.agents.some((a) => a.name === 'build'));
        assert.ok(s.commands.some((c) => c.name === 'greet' && c.source === 'engine'));
        assert.ok(s.commands.some((c) => c.name === 'mcp' && c.source === 'builtin'));
        assert.equal(s.mcp.find((m) => m.name === 'mockmcp')?.status, 'connected');
      });

      it('chats end to end and records token usage', async () => {
        await api.controller.handleMessage({ type: 'send', text: 'hello from vscode' });
        await until('assistant reply', () => state().activity === 'idle' && state().messages.some((m) => m.role === 'assistant' && m.completedAt));
        const s = state();
        assert.deepEqual(texts(s.messages[1].parts), ['MOCK[mock-small]: hello from vscode']);
        const usage = await until('usage', () => state().sessionUsage);
        assert.equal(usage.usage.input, 100);
        assert.equal(usage.usage.output, 30);
        assert.equal(api.ledger.summary().byModel[0].modelId, 'mock-small');
      });

      it('attaches the editor selection and the active file through commands', async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'hello.txt'));
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, 28);
        await vscode.commands.executeCommand('opencodeHub.attachSelection');
        await vscode.commands.executeCommand('opencodeHub.attachActiveFile', doc.uri);
        const atts = await until('attachments', () => (state().attachments.length === 2 ? state().attachments : undefined), 10_000);
        assert.equal(atts[0].kind, 'selection');
        assert.equal(atts[0].name, 'hello.txt:1-1');
        assert.equal(atts[0].text, 'the secret word is pineapple');
        assert.equal(atts[1].name, 'hello.txt');
        await api.controller.handleMessage({ type: 'send', text: 'what is in the attachment?' });
        await until('reply', () => state().activity === 'idle' && state().messages.filter((m) => m.role === 'assistant' && m.completedAt).length === 2);
        assert.equal(state().attachments.length, 0);
      });

      it('explains a selection and fixes a reported problem straight from the editor', async () => {
        const doc = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'hello.txt'));
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, 28);
        const done = () => state().messages.filter((m) => m.role === 'assistant' && m.completedAt).length;
        const said = () => state().messages.flatMap((m) => texts(m.parts)).join('\n');
        let n = done();
        await vscode.commands.executeCommand('opencodeHub.explainSelection');
        await until('explanation', () => state().activity === 'idle' && done() > n);
        assert.match(said(), /Explain the attached code/);

        // What the lightbulb runs: a document, the range of the problem and its message.
        n = done();
        await vscode.commands.executeCommand('opencodeHub.fixSelection', doc.uri, new vscode.Range(1, 0, 1, 6), 'test(42): the second line is wrong');
        await until('fix', () => state().activity === 'idle' && done() > n);
        assert.match(said(), /Fix this problem in hello\.txt, around line 2/);
        assert.match(said(), /test\(42\): the second line is wrong/);
        assert.equal(state().attachments.length, 0);
      });

      it('offers the open file as context and attaches it with one click', async () => {
        const file = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'hello.txt');
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await until('current-file chip', () => state().activeFile?.path === file && !state().activeFile?.selection, 10_000);
        await api.controller.handleMessage({ type: 'addActiveFile' });
        await until('attached', () => state().attachments.some((a) => a.path === file && !a.range), 10_000);
        editor.selection = new vscode.Selection(1, 0, 1, 6);
        await until('selection offered', () => state().activeFile?.selection?.startLine === 2, 10_000);
        await api.controller.handleMessage({ type: 'addActiveFile' });
        await until('selection attached', () => state().attachments.some((a) => a.kind === 'selection' && a.range?.startLine === 2), 10_000);
        for (const a of state().attachments) await api.controller.handleMessage({ type: 'removeAttachment', id: a.id });
      });

      it('finds workspace files for @ mentions', async () => {
        const found = await vscode.workspace.findFiles('**/*hel*', null, 10);
        assert.ok(found.some((u) => u.fsPath.endsWith('hello.txt')));
      });

      it('runs /greet, toggles MCP and switches sessions', async () => {
        await api.controller.handleMessage({ type: 'send', text: '/greet VS Code' });
        await until('greet reply', () => state().activity === 'idle' && state().messages.some((m) => m.role === 'assistant' && texts(m.parts).includes('MOCK[mock-small]: Say hello to VS Code')));
        await api.controller.handleMessage({ type: 'mcpToggle', name: 'mockmcp', enabled: false });
        assert.equal(state().mcp.find((m) => m.name === 'mockmcp')?.status, 'disabled');
        await api.controller.handleMessage({ type: 'mcpToggle', name: 'mockmcp', enabled: true });
        assert.equal(state().mcp.find((m) => m.name === 'mockmcp')?.status, 'connected');

        const first = state().sessionId!;
        await vscode.commands.executeCommand('opencodeHub.newSession');
        assert.equal(state().sessionId, undefined);
        await api.controller.handleMessage({ type: 'switchSession', sessionId: first });
        assert.equal(state().sessionId, first);
        assert.ok(state().messages.length >= 6);
      });
    });

    // Mocha runs a suite's own tests before its child suites, so the remaining tests live in
    // their own suite to keep them after the opencode group.
    describe('with other engines and view commands', () => {
    it('uses a BYOK provider added through settings, with no opencode involved', async () => {
      await vscode.workspace.getConfiguration('opencodeHub').update('providers', [{ id: 'mocklocal', name: 'Mock Local', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${mockPort}/v1` }], vscode.ConfigurationTarget.Global);
      await api.controller.setEngine('direct');
      await until('direct engine ready', () => state().engine === 'direct' && !state().loading && state().providers.some((p) => p.id === 'mocklocal' && p.models.length > 0), 30_000);
      assert.deepEqual(state().model, { providerId: 'mocklocal', modelId: 'mock-large' });
      await api.controller.handleMessage({ type: 'send', text: 'direct from vscode' });
      await until('direct reply', () => state().activity === 'idle' && state().messages.some((m) => m.role === 'assistant' && m.completedAt));
      assert.deepEqual(texts(state().messages[1].parts), ['MOCK[mock-large]: direct from vscode']);
      await until('direct usage', () => api.ledger.summary().byModel.some((r) => r.engine === 'direct' && r.providerId === 'mocklocal'));
      // Usage survives in VS Code's global state.
      await api.ledger.flush();
    });

    it('toggles the companion through the command and the setting', async () => {
      assert.equal(state().avatar.enabled, true);
      await vscode.commands.executeCommand('opencodeHub.toggleAvatar');
      await until('avatar off', () => state().avatar.enabled === false, 10_000);
      assert.equal(vscode.workspace.getConfiguration('opencodeHub').get('avatar.enabled'), false);
      await vscode.commands.executeCommand('opencodeHub.toggleAvatar');
      await until('avatar on', () => state().avatar.enabled === true, 10_000);
    });

    it('scales the chat text with the zoom commands', async () => {
      await vscode.commands.executeCommand('opencodeHub.zoomReset');
      await vscode.commands.executeCommand('opencodeHub.zoomIn');
      await vscode.commands.executeCommand('opencodeHub.zoomIn');
      await until('zoom 1.2', () => state().zoom === 1.2, 10_000);
      assert.equal(vscode.workspace.getConfiguration('opencodeHub').get('chat.zoom'), 1.2);
      await vscode.commands.executeCommand('opencodeHub.zoomOut');
      await until('zoom 1.1', () => state().zoom === 1.1, 10_000);
      await vscode.commands.executeCommand('opencodeHub.zoomReset');
      await until('zoom 1', () => state().zoom === 1, 10_000);
    });

    it('opens the chat as an editor tab next to the side bar view', async () => {
      const before = api.view.surfaceCount;
      await vscode.commands.executeCommand('opencodeHub.openInEditor');
      await until('editor tab', () => api.view.hasPanel && api.view.surfaceCount === before + 1, 20_000);
      // Both places show the same chat; sending still works with two views attached.
      await api.controller.handleMessage({ type: 'newSession' });
      await api.controller.handleMessage({ type: 'send', text: 'from the editor tab' });
      await until('reply', () => state().activity === 'idle' && state().messages.some((m) => m.role === 'assistant' && m.completedAt));
      api.view.closePanel();
      await until('tab closed', () => !api.view.hasPanel && api.view.surfaceCount === before, 10_000);
      assert.equal(api.controller.isWebviewReady, true);
    });

    it('moves the chat to the right (secondary) side bar and back', async function () {
      // VS Code registers a command named after every contributed view container.
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('workbench.view.extension.opencodeHub'));
      if (!commands.includes('workbench.view.extension.opencodeHubSecondary')) {
        console.log(`      VS Code ${vscode.version} cannot contribute a secondary side bar container; the command falls back to the interactive "Move View" picker`);
        return this.skip();
      }
      await vscode.commands.executeCommand('opencodeHub.moveToRight');
      await until('chat usable on the right', () => api.controller.isWebviewReady && api.view.visible, 20_000);
      await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
      assert.equal(api.view.visible, true);
      await api.controller.handleMessage({ type: 'send', text: 'from the right side' });
      await until('reply', () => state().activity === 'idle' && state().messages.filter((m) => m.role === 'assistant' && m.completedAt).length >= 2);
      await vscode.commands.executeCommand('opencodeHub.moveToLeft');
      await until('chat usable on the left', () => api.controller.isWebviewReady && api.view.visible, 20_000);
    });

    it('opens the MCP and usage panels from commands', async () => {
      await vscode.commands.executeCommand('opencodeHub.showMcp');
      assert.equal(state().panel.name, 'mcp');
      await vscode.commands.executeCommand('opencodeHub.showUsage');
      assert.equal(state().panel.name, 'usage');
      assert.ok(state().usage);
    });
    });
  });

  await new Promise<void>((resolve, reject) => mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve())));
}
