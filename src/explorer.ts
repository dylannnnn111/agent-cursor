// Badges in the normal file explorer. VS Code only allows a 1-2 character badge
// and a theme colour here, so: ✦ where an agent is right now, ✎ for files it
// changed, • for files it read. The animated view lives in the Agent panel.

import * as vscode from 'vscode';
import { Model, isBusy } from './core/state';

export class ExplorerBadges implements vscode.FileDecorationProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private shown = new Set<string>();
  private registration: vscode.Disposable;

  constructor(private readonly model: Model) {
    this.registration = vscode.window.registerFileDecorationProvider(this);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const file = uri.fsPath;
    const here = [...this.model.agents.values()].filter((a) => a.file === file);
    if (here.length) {
      const a = here.find(isBusy) ?? here[0];
      const d = new vscode.FileDecoration(
        '✦',
        here.map((h) => `${h.label}: ${h.detail}`).join('\n'),
        new vscode.ThemeColor(`agentCursor.agent${a.colorIndex}`),
      );
      d.propagate = true;
      return d;
    }
    const t = this.model.touched.get(file);
    if (!t) return undefined;
    return new vscode.FileDecoration(
      t.edited ? '✎' : '•',
      t.edited ? 'Changed by the agent' : 'Read by the agent',
      new vscode.ThemeColor(`agentCursor.agent${t.colorIndex}`),
    );
  }

  refresh() {
    const now = new Set<string>();
    for (const a of this.model.agents.values()) if (a.file) now.add(a.file);
    for (const f of this.model.touched.keys()) now.add(f);
    const changed = new Set([...now, ...this.shown]);
    this.shown = now;
    if (changed.size) this.emitter.fire([...changed].map((f) => vscode.Uri.file(f)));
  }

  dispose() {
    this.registration.dispose();
    this.emitter.dispose();
  }
}
