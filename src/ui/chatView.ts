import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import type { ChatController } from './controller';

/** Hosts the chat webview in the OpenCode Hub activity-bar view. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'opencodeHub.chat';
  private view: vscode.WebviewView | undefined;
  private queue: HostToWebview[] = [];
  controller: ChatController | undefined;

  constructor(private readonly extensionUri: vscode.Uri, private readonly log: vscode.LogOutputChannel) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      this.controller?.handleMessage(msg).catch((err) => this.log.error(`Failed to handle ${msg?.type}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    });
    view.onDidChangeVisibility(() => void view.webview.postMessage({ type: 'visible', visible: view.visible } satisfies HostToWebview));
    view.onDidDispose(() => {
      this.view = undefined;
      this.controller?.webviewDisposed();
    });
    for (const m of this.queue.splice(0)) void view.webview.postMessage(m);
  }

  post(message: HostToWebview): void {
    if (this.view) void this.view.webview.postMessage(message);
    else if (message.type === 'insertText' || message.type === 'focusInput') this.queue.push(message);
  }

  get visible(): boolean {
    return !!this.view?.visible;
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
