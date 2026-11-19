import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import type { ChatController } from './controller';

/**
 * Hosts the chat webview. The same chat can be shown in two places at once: the side bar
 * view (left or right, wherever the user docked it) and an editor tab. Every surface
 * mirrors the same controller state.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  static readonly viewId = 'opencodeHub.chat';
  static readonly panelType = 'opencodeHub.chatPanel';
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private surfaces = new Set<vscode.Webview>();
  private queue: HostToWebview[] = [];
  controller: ChatController | undefined;

  constructor(private readonly extensionUri: vscode.Uri, private readonly log: vscode.LogOutputChannel) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    this.attach(webview);
    view.onDidChangeVisibility(() => {
      if (this.view === view) void webview.postMessage({ type: 'visible', visible: view.visible } satisfies HostToWebview);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      this.detach(webview);
    });
  }

  /** Open (or reveal) the chat as an editor tab, which can be resized, split or moved to its own window. */
  openPanel(): void {
    if (this.panel) return this.panel.reveal();
    const panel = vscode.window.createWebviewPanel(ChatViewProvider.panelType, 'OpenCode Hub', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: this.roots() });
    this.adopt(panel);
  }

  /** Restores the editor tab after a window reload. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel) return panel.dispose();
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    // Keep our own reference: `panel.webview` throws once the panel is disposed.
    const webview = panel.webview;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    this.attach(webview);
    panel.onDidChangeViewState(() => {
      if (this.panel === panel) void webview.postMessage({ type: 'visible', visible: panel.visible } satisfies HostToWebview);
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      this.detach(webview);
    });
  }

  private roots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')];
  }

  private attach(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    this.surfaces.add(webview);
    webview.onDidReceiveMessage((msg: WebviewToHost) => {
      this.controller?.handleMessage(msg).catch((err) => this.log.error(`Failed to handle ${msg?.type}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    });
    webview.html = this.html(webview);
    for (const m of this.queue.splice(0)) void webview.postMessage(m);
  }

  private detach(webview: vscode.Webview): void {
    this.surfaces.delete(webview);
    if (this.surfaces.size === 0) this.controller?.webviewDisposed();
  }

  post(message: HostToWebview): void {
    if (this.surfaces.size === 0) {
      if (message.type === 'insertText' || message.type === 'focusInput') this.queue.push(message);
      return;
    }
    for (const webview of this.surfaces) void webview.postMessage(message);
  }

  get visible(): boolean {
    return !!this.view?.visible || !!this.panel?.visible;
  }

  /** True when the chat is only open as an editor tab (so "focus" should reveal that tab). */
  get panelOnly(): boolean {
    return !!this.panel && !this.view?.visible;
  }

  revealPanel(): void {
    this.panel?.reveal();
  }

  get hasPanel(): boolean {
    return !!this.panel;
  }

  closePanel(): void {
    this.panel?.dispose();
  }

  /** Number of places the chat is currently shown in. */
  get surfaceCount(): number {
    return this.surfaces.size;
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...p)).toString();
    // No remote content of any kind: scripts and styles come from the extension, images only from data/blob URLs.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${asset('dist', 'webview.css')}" />
<title>OpenCode Hub</title>
</head>
<body>
<div id="root" data-avatar-src="${asset('dist', 'avatar.js')}"></div>
<script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}
