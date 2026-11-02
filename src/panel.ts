// The Agent sidebar panel: the project's files with each agent shown as a
// marker that slides to whichever file it's in, plus a feed of what it did.

import * as vscode from 'vscode';
import { Model, snapshot } from './core/state';

const EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/target/**,**/.DS_Store}';
const MAX_FILES = 3000;

export interface PanelHost {
  follow(): boolean;
  setFollow(on: boolean): void;
  connected(): boolean;
  connect(): void;
  demo(): void;
}

export class AgentPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'agentCursor.panel';
  private view?: vscode.WebviewView;
  private files: string[] = [];
  private disposables: vscode.Disposable[] = [];
  private pending?: NodeJS.Timeout;
  private fileTimer?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: Model,
    private readonly host: PanelHost,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    watcher.onDidCreate(() => this.scheduleFiles());
    watcher.onDidDelete(() => this.scheduleFiles());
    this.disposables.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleFiles()));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.pushAll(), undefined, this.disposables);
    this.loadFiles();
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  reveal() {
    if (this.view) this.view.show(true);
    else vscode.commands.executeCommand(`${AgentPanel.id}.focus`);
  }

  // throttled: the hook can fire many events a second
  update() {
    if (!this.view || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post({ type: 'state', state: this.state() });
    }, 60);
  }

  private state() {
    return {
      ...snapshot(this.model, Date.now()),
      follow: this.host.follow(),
      connected: this.host.connected(),
    };
  }

  private pushAll() {
    this.post({
      type: 'files',
      roots: (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath })),
      files: this.files,
      truncated: this.files.length >= MAX_FILES,
    });
    this.post({ type: 'state', state: this.state() });
  }

  private scheduleFiles() {
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => this.loadFiles(), 500);
  }

  private async loadFiles() {
    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, MAX_FILES);
    this.files = uris.map((u) => u.fsPath).sort();
    this.pushAll();
  }

  private onMessage(msg: any) {
    switch (msg?.type) {
      case 'ready':
        this.pushAll();
        break;
      case 'open': {
        if (typeof msg.file !== 'string') return;
        const line = typeof msg.line === 'number' ? msg.line : 0;
        vscode.window.showTextDocument(vscode.Uri.file(msg.file), {
          preview: true,
          selection: new vscode.Range(line, 0, line, 0),
        });
        break;
      }
      case 'follow':
        this.host.setFollow(!!msg.on);
        break;
      case 'connect':
        this.host.connect();
        break;
      case 'demo':
        this.host.demo();
        break;
    }
  }

  private post(msg: unknown) {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Agent Cursor</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    if (this.pending) clearTimeout(this.pending);
    if (this.fileTimer) clearTimeout(this.fileTimer);
  }
}
