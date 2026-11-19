import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Engine, EngineContext } from './core/engine';
import { newId } from './core/ids';
import { UsageLedger, folderScopedState } from './core/usageLedger';
import { ClaudeCodeEngine } from './engines/cli/claudeCode';
import { CodexEngine } from './engines/cli/codex';
import { DirectEngine } from './engines/direct/engine';
import { OpencodeEngine } from './engines/opencode/engine';
import { VscodeLmEngine } from './engines/vscodeLm/engine';
import { McpManager } from './mcp/manager';
import type { McpServerConfig } from './mcp/manager';
import { repoSlug } from './shared/feedback';
import { ENGINE_LABELS, totalTokens } from './shared/types';
import type { EngineId } from './shared/types';
import { ChatViewProvider } from './ui/chatView';
import { ChatController } from './ui/controller';
import type { ControllerHost, PickItem } from './ui/controller';

const SECTION = 'opencodeHub';
const CONTAINER_LEFT = 'workbench.view.extension.opencodeHub';
const CONTAINER_RIGHT = 'workbench.view.extension.opencodeHubSecondary';

/** Returned from `activate` so integration tests (and other extensions) can drive the chat. */
export interface OpencodeHubApi {
  controller: ChatController;
  view: ChatViewProvider;
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

  /**
   * The file the user is working in. Opening the chat in an editor tab, or clicking into it,
   * leaves no active text editor, so the last file editor that is still visible counts.
   */
  let lastEditor: vscode.TextEditor | undefined;
  const isFileEditor = (e: vscode.TextEditor | undefined): e is vscode.TextEditor => !!e && e.document.uri.scheme === 'file';
  const activeEditor = (): vscode.TextEditor | undefined => {
    const current = vscode.window.activeTextEditor;
    if (isFileEditor(current)) return current;
    return lastEditor && vscode.window.visibleTextEditors.includes(lastEditor) ? lastEditor : vscode.window.visibleTextEditors.find(isFileEditor);
  };
  const selectionAttachmentOf = (editor: vscode.TextEditor) => {
    const doc = editor.document;
    const sel = editor.selection;
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return { id: newId('att'), kind: 'selection' as const, name: `${vscode.workspace.asRelativePath(doc.uri, false)}:${sel.start.line + 1}-${endLine}`, mime: 'text/plain', path: doc.uri.fsPath, text: doc.getText(sel), range: { startLine: sel.start.line + 1, endLine } };
  };

  const host: ControllerHost = {
    log,
    post: (m) => view.post(m),
    state: folderScopedState(context.globalState, context.workspaceState, cwd),
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
    focusView: async () => {
      if (view.panelOnly) view.revealPanel();
      else await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    },
    moveView: async (to) => {
      if (to === 'editor') return view.openPanel();
      // View containers contributed by an extension get a command named after their id.
      const destination = to === 'right' ? CONTAINER_RIGHT : CONTAINER_LEFT;
      if (!(await vscode.commands.getCommands(true)).includes(destination)) {
        // Older VS Code cannot contribute a secondary side bar container: let the user pick the place.
        await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
        await vscode.commands.executeCommand('workbench.action.moveFocusedView');
        void vscode.window.showInformationMessage('Choose "New Secondary Side Bar Entry" to dock the chat on the right. You can also drag the chat icon there.');
        return;
      }
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [ChatViewProvider.viewId], destinationId: destination });
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    },
    environment: () => ({
      extensionVersion: String((context.extension.packageJSON as { version?: string }).version ?? 'unknown'),
      editor: `${vscode.env.appName} ${vscode.version}`,
      ui: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
      remote: vscode.env.remoteName,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    }),
    activeFileAttachment: () => {
      const editor = activeEditor();
      if (!editor) return undefined;
      if (!editor.selection.isEmpty) return selectionAttachmentOf(editor);
      return { id: '', kind: 'file' as const, name: vscode.workspace.asRelativePath(editor.document.uri, false), mime: 'text/plain', path: editor.document.uri.fsPath };
    },
    repository: () => {
      const pkg = context.extension.packageJSON as { repository?: string | { url?: string } };
      return repoSlug(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
    },
  };

  const controller = new ChatController(engines, ledger, host);
  view.controller = controller;

  // The open file, offered in the chat as a one-click chip (like Copilot's "current file").
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  const pushActiveFile = () => {
    if (fileTimer) clearTimeout(fileTimer);
    fileTimer = setTimeout(() => {
      const editor = activeEditor();
      if (isFileEditor(vscode.window.activeTextEditor)) lastEditor = vscode.window.activeTextEditor;
      if (!editor) return controller.setActiveFile(undefined);
      const sel = editor.selection;
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      controller.setActiveFile({ path: editor.document.uri.fsPath, name: vscode.workspace.asRelativePath(editor.document.uri, false), selection: sel.isEmpty ? undefined : { startLine: sel.start.line + 1, endLine } });
    }, 120);
  };
  pushActiveFile();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(pushActiveFile),
    vscode.window.onDidChangeVisibleTextEditors(pushActiveFile),
    vscode.window.onDidChangeTextEditorSelection(pushActiveFile),
    { dispose: () => fileTimer && clearTimeout(fileTimer) },
  );

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

  /** A few lines around a problem, as an attachment the model can read. */
  const rangeAttachment = (doc: vscode.TextDocument, range: vscode.Range, padding = 3) => {
    const start = Math.max(0, range.start.line - padding);
    const end = Math.min(doc.lineCount - 1, range.end.line + padding);
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    return {
      id: newId('att'),
      kind: 'selection' as const,
      name: `${rel}:${start + 1}-${end + 1}`,
      mime: 'text/plain',
      path: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
      text: doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length)),
      range: { startLine: start + 1, endLine: end + 1 },
    };
  };

  /** Attach code and ask about it in one step (editor context menu and the lightbulb). */
  const askAboutCode = async (attachment: ReturnType<typeof rangeAttachment> | undefined, prompt: string) => {
    if (!attachment) return void vscode.window.showInformationMessage('Select some code first.');
    await host.focusView();
    if (controller.viewState.activity !== 'idle') return void vscode.window.showInformationMessage('OpenCode Hub is still working on the previous message. Stop it or wait, then try again.');
    controller.addAttachment(attachment);
    await controller.send(prompt);
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
  reg('opencodeHub.signIn', () => controller.accountMenu());
  reg('opencodeHub.toggleAutoMode', () => controller.setApprovals(controller.viewState.approvals === 'auto' ? 'ask' : 'auto'));
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
  reg('opencodeHub.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false));
  reg('opencodeHub.sendFeedback', async () => {
    await host.focusView();
    controller.showPanel('feedback');
  });
  reg('opencodeHub.doctor', async () => {
    await host.focusView();
    await controller.send('/doctor');
  });
  reg('opencodeHub.abort', () => controller.abort());
  reg('opencodeHub.moveToRight', () => host.moveView('right'));
  reg('opencodeHub.moveToLeft', () => host.moveView('left'));
  reg('opencodeHub.openInEditor', () => host.moveView('editor'));
  reg('opencodeHub.zoomIn', () => controller.zoom(0.1));
  reg('opencodeHub.zoomOut', () => controller.zoom(-0.1));
  reg('opencodeHub.zoomReset', () => controller.setZoom(1));
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
  reg('opencodeHub.explainSelection', () => askAboutCode(selectionAttachment(), 'Explain the attached code: what it does, how it does it, and anything in it that looks risky or surprising.'));
  reg('opencodeHub.fixSelection', async (uri?: vscode.Uri, range?: vscode.Range, problem?: string) => {
    // From the lightbulb: a document, the range of the problem and its message. From the menu: the selection.
    if (uri instanceof vscode.Uri && range instanceof vscode.Range) {
      const doc = await vscode.workspace.openTextDocument(uri);
      return askAboutCode(rangeAttachment(doc, range), fixPrompt(vscode.workspace.asRelativePath(uri, false), range.start.line + 1, problem));
    }
    const editor = vscode.window.activeTextEditor;
    const att = selectionAttachment();
    if (!editor || !att) return void vscode.window.showInformationMessage('Select the code to fix first.');
    const problems = vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.range.intersection(editor.selection) && d.severity <= vscode.DiagnosticSeverity.Warning);
    return askAboutCode(att, fixPrompt(vscode.workspace.asRelativePath(editor.document.uri, false), editor.selection.start.line + 1, problems.map(describeProblem).join('\n') || undefined));
  });
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      {
        provideCodeActions: (doc, _range, ctx) => {
          if (!cfg().get('editor.quickFix', true) || !vscode.workspace.isTrusted) return [];
          return ctx.diagnostics
            .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
            .slice(0, 3)
            .map((d) => {
              const action = new vscode.CodeAction(`Fix with OpenCode Hub: ${truncateLine(d.message, 60)}`, vscode.CodeActionKind.QuickFix);
              action.diagnostics = [d];
              action.command = { command: 'opencodeHub.fixSelection', title: 'Fix with OpenCode Hub', arguments: [doc.uri, d.range, describeProblem(d)] };
              return action;
            });
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
  reg('opencodeHub.attachFiles', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const picked = (uris?.length ? uris : uri ? [uri] : []).filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    await host.focusView();
    if (picked.length) await controller.addPaths(picked);
    else await controller.pickFiles();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelType, view),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      renderStatus();
      if (e.affectsConfiguration(`${SECTION}.mcp`)) void mcp.sync();
      const providers = e.affectsConfiguration(`${SECTION}.providers`);
      if (providers || e.affectsConfiguration(`${SECTION}.avatar`) || e.affectsConfiguration(`${SECTION}.chat`) || e.affectsConfiguration(`${SECTION}.approvals`)) controller.onConfigChanged(providers);
      if (e.affectsConfiguration(`${SECTION}.claudeCode.auth`) || e.affectsConfiguration(`${SECTION}.codex.auth`)) controller.onAuthConfigChanged();
      if (e.affectsConfiguration(`${SECTION}.claudeCode.models`) || e.affectsConfiguration(`${SECTION}.codex.models`)) controller.onModelsConfigChanged();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void controller.onTrustChanged()),
    // Back from the browser or a terminal: a sign-in may have happened there.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && view.visible) controller.onShown();
    }),
    {
      dispose: () => {
        controller.dispose();
        void ledger.flush();
        void mcp.dispose();
        void shutdownEngines();
      },
    },
  );

  // Start in the background: activation must not wait for a CLI to boot.
  void controller.activate().catch((err) => log.error(`Activation failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  activeEngines = engines;
  shutdown = undefined;
  return { controller, view, engines, ledger };
}

let activeEngines: Map<EngineId, Engine> | undefined;
let shutdown: Promise<void> | undefined;

/** Stop every engine once; local engines save running replies to disk first. */
function shutdownEngines(): Promise<void> {
  const list = activeEngines;
  shutdown ??= list ? Promise.all([...list.values()].map((e) => e.dispose().catch(() => undefined))).then(() => undefined) : Promise.resolve();
  return shutdown;
}

/** VS Code waits for this promise (a few seconds) on shutdown: running replies are saved to disk. */
export function deactivate(): Promise<void> {
  return shutdownEngines();
}

function truncateLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** "ts(2322): Type 'string' is not assignable to type 'number'." */
function describeProblem(d: vscode.Diagnostic): string {
  const code = typeof d.code === 'object' ? d.code.value : d.code;
  const origin = [d.source, code !== undefined && code !== '' ? `(${code})` : ''].filter(Boolean).join('');
  return `${origin ? `${origin}: ` : ''}${truncateLine(d.message, 600)}`;
}

function fixPrompt(file: string, line: number, problem: string | undefined): string {
  return problem
    ? `Fix this problem in ${file}, around line ${line}:\n\n${problem}\n\nThe code is attached. Find the cause, change only what is needed, and say briefly what you changed.`
    : `Find and fix what is wrong in the attached code from ${file} (around line ${line}). Change only what is needed, and say briefly what you changed.`;
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
