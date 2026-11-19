import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Engine, EngineContext } from './core/engine';
import { newId } from './core/ids';
import { UsageLedger } from './core/usageLedger';
import { ClaudeCodeEngine } from './engines/cli/claudeCode';
import { CodexEngine } from './engines/cli/codex';
import { DirectEngine } from './engines/direct/engine';
import { OpencodeEngine } from './engines/opencode/engine';
import { VscodeLmEngine } from './engines/vscodeLm/engine';
import { McpManager } from './mcp/manager';
import type { McpServerConfig } from './mcp/manager';
import { ENGINE_LABELS, totalTokens } from './shared/types';
import type { EngineId } from './shared/types';
import { ChatViewProvider } from './ui/chatView';
import { ChatController } from './ui/controller';
import type { ControllerHost, PickItem } from './ui/controller';

const SECTION = 'opencodeHub';

/** Returned from `activate` so integration tests (and other extensions) can drive the chat. */
export interface OpencodeHubApi {
  controller: ChatController;
  engines: Map<EngineId, Engine>;
  ledger: UsageLedger;
}

export async function activate(context: vscode.ExtensionContext): Promise<OpencodeHubApi> {
  const log = vscode.window.createOutputChannel('OpenCode Hub', { log: true });
  context.subscriptions.push(log);
  const cfg = () => vscode.workspace.getConfiguration(SECTION);
  const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const updateConfig = async (key: string, value: unknown) => {
    const inspected = cfg().inspect(key);
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg().update(key, value, target);
  };

  const engineContext: EngineContext = {
    log,
    cwd,
    config: (key, fallback) => cfg().get(key, fallback),
    secrets: {
      get: async (k) => context.secrets.get(k),
      set: async (k, v) => context.secrets.store(k, v),
      delete: async (k) => context.secrets.delete(k),
    },
    storageDir: context.globalStorageUri.fsPath,
  };

  const mcp = new McpManager({
    log,
    cwd,
    readConfig: () => cfg().get<Record<string, McpServerConfig>>('mcp.servers', {}) ?? {},
    writeEnabled: async (name, enabled) => {
      const servers = { ...(cfg().get<Record<string, McpServerConfig>>('mcp.servers', {}) ?? {}) };
      if (!servers[name]) return;
      servers[name] = { ...servers[name], enabled };
      await updateConfig('mcp.servers', servers);
    },
  });

  const engines = new Map<EngineId, Engine>([
    ['opencode', new OpencodeEngine(engineContext)],
    ['direct', new DirectEngine(engineContext, mcp)],
    ['claude-code', new ClaudeCodeEngine(engineContext)],
    ['codex', new CodexEngine(engineContext)],
    ['vscode-lm', new VscodeLmEngine(engineContext, vscode, mcp)],
  ]);

  const ledger = new UsageLedger(context.globalState);
  const view = new ChatViewProvider(context.extensionUri, log);

  const host: ControllerHost = {
    log,
    post: (m) => view.post(m),
    state: context.workspaceState,
    secrets: engineContext.secrets,
    config: engineContext.config,
    updateConfig,
    workspaceTrusted: () => vscode.workspace.isTrusted,
    cwd,
    info: (m) => void vscode.window.showInformationMessage(m),
    error: (m) => void vscode.window.showErrorMessage(m),
    pick: async <T>(items: PickItem<T>[], options: { title: string; placeholder?: string }) => {
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({ label: i.label, description: i.description, detail: i.detail, item: i })),
        { title: options.title, placeHolder: options.placeholder, matchOnDescription: true, matchOnDetail: true },
      );
      return picked?.item.value;
    },
    input: (o) => Promise.resolve(vscode.window.showInputBox({ title: o.title, prompt: o.prompt, value: o.value, password: o.password, placeHolder: o.placeholder, ignoreFocusOut: true })),
    confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    pickFiles: async () => ((await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: 'Attach' })) ?? []).map((u) => u.fsPath),
    findFiles: async (query, limit) => {
      const clean = query.replace(/[[\]{}*?]/g, '');
      const glob = clean ? `**/*${clean.split('').join('*')}*` : '**/*';
      const found = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,dist,out,build,.venv,__pycache__}/**', 200);
      const q = clean.toLowerCase();
      return found
        .map((u) => ({ path: u.fsPath, relative: vscode.workspace.asRelativePath(u, false) }))
        .sort((a, b) => score(a.relative, q) - score(b.relative, q) || a.relative.length - b.relative.length)
        .slice(0, limit);
    },
    openFile: async (file) => {
      const target = path.isAbsolute(file) ? file : path.join(cwd() ?? '', file);
      await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
    },
    openExternal: async (url) => void (await vscode.env.openExternal(vscode.Uri.parse(url))),
    copy: async (text) => vscode.env.clipboard.writeText(text),
    insertIntoEditor: async (text) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a file to insert the code into.');
        return;
      }
      await editor.edit((b) => b.replace(editor.selection, text));
    },
    saveText: async (name, content) => {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(cwd() ?? '', name)), filters: { Markdown: ['md'] } });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      await vscode.window.showTextDocument(uri);
    },
    openSettings: async (query) => void (await vscode.commands.executeCommand('workbench.action.openSettings', query)),
    runInTerminal: (name, command) => {
      const terminal = vscode.window.createTerminal({ name, cwd: cwd() });
      terminal.show();
      terminal.sendText(command);
    },
    focusView: async () => void (await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`)),
  };

  const controller = new ChatController(engines, ledger, host);
  view.controller = controller;

  // Status bar: tokens of the current session.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'opencodeHub.showUsage';
  const renderStatus = () => {
    if (!cfg().get('usage.statusBar', true)) return statusBar.hide();
    const s = controller.viewState;
    const u = s.sessionId ? ledger.sessionUsage(s.engine, s.sessionId)?.usage : undefined;
    const total = ledger.summary(0).total;
    statusBar.text = `$(pulse) ${compact(u ? totalTokens(u) : 0)} tok${u?.cost ? ` · $${u.cost.toFixed(2)}` : ''}`;
    statusBar.tooltip = new vscode.MarkdownString(
      `**OpenCode Hub** — ${ENGINE_LABELS[s.engine]}\n\nThis session: ${u ? `${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out · ${(u.cacheRead + u.cacheWrite).toLocaleString()} cached` : 'no usage yet'}\n\nAll sessions: ${totalTokens(total).toLocaleString()} tokens${total.cost ? ` · $${total.cost.toFixed(2)}` : ''}\n\nClick for details.`,
    );
    statusBar.show();
  };
  renderStatus();
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleStatus = () => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(renderStatus, 500);
  };
  context.subscriptions.push(statusBar, ledger.onDidChange(scheduleStatus), { dispose: () => statusTimer && clearTimeout(statusTimer) });
  for (const e of engines.values()) context.subscriptions.push(e.onEvent((ev) => (ev.type === 'session.status' || ev.type === 'engine.status') && scheduleStatus()));

  const selectionAttachment = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return undefined;
    const doc = editor.document;
    const sel = editor.selection;
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    return {
      id: newId('att'),
      kind: 'selection' as const,
      name: `${rel}:${sel.start.line + 1}-${endLine}`,
      mime: 'text/plain',
      path: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
      text: doc.getText(sel),
      range: { startLine: sel.start.line + 1, endLine },
    };
  };

  const reg = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown));
  reg('opencodeHub.focus', async () => {
    await host.focusView();
    view.post({ type: 'focusInput' });
  });
  reg('opencodeHub.newSession', async () => {
    await host.focusView();
    await controller.newSession();
  });
  reg('opencodeHub.switchSession', () => controller.pickSession());
  reg('opencodeHub.selectEngine', () => controller.pickEngine());
  reg('opencodeHub.selectModel', () => controller.pickModel());
  reg('opencodeHub.manageProviders', () => controller.manageProviders());
  reg('opencodeHub.showMcp', async () => {
    await host.focusView();
    controller.showPanel('mcp');
  });
  reg('opencodeHub.showUsage', async () => {
    await host.focusView();
    controller.showPanel('usage');
  });
  reg('opencodeHub.resetUsage', () => controller.resetUsage());
  reg('opencodeHub.toggleAvatar', () => controller.setAvatar({ enabled: !controller.viewState.avatar.enabled }));
  reg('opencodeHub.restartEngine', () => controller.restartEngine());
  reg('opencodeHub.showLogs', () => log.show());
  reg('opencodeHub.abort', () => controller.abort());
  reg('opencodeHub.attachActiveFile', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (target?.scheme !== 'file') return;
    await host.focusView();
    await controller.addPaths([target.fsPath]);
  });
  reg('opencodeHub.attachSelection', async () => {
    const att = selectionAttachment();
    if (!att) return void vscode.window.showInformationMessage('Select some code first.');
    await host.focusView();
    controller.addAttachment(att);
    view.post({ type: 'focusInput' });
  });
  reg('opencodeHub.attachFiles', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const picked = (uris?.length ? uris : uri ? [uri] : []).filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    await host.focusView();
    if (picked.length) await controller.addPaths(picked);
    else await controller.pickFiles();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      renderStatus();
      if (e.affectsConfiguration(`${SECTION}.mcp`)) void mcp.sync();
      if (e.affectsConfiguration(`${SECTION}.providers`) || e.affectsConfiguration(`${SECTION}.avatar`)) controller.onConfigChanged();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void controller.onTrustChanged()),
    {
      dispose: () => {
        controller.dispose();
        void ledger.flush();
        void mcp.dispose();
        for (const e of engines.values()) void e.dispose();
      },
    },
  );

  // Start in the background: activation must not wait for a CLI to boot.
  void controller.activate().catch((err) => log.error(`Activation failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  return { controller, engines, ledger };
}

export function deactivate(): void {
  /* resources are released through context.subscriptions */
}

function score(relative: string, q: string): number {
  if (!q) return 0;
  const lower = relative.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  return 4;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
