import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { colorOf } from './colors';
import { Agent, HookEvent, apply, createModel, isBusy, resolveFile, tick } from './core/state';
import { demoScript, pickDemoFiles } from './demo';
import { EditorView } from './editor';
import { ExplorerBadges } from './explorer';
import { AgentPanel } from './panel';
import { LOG_FILE, connect, disconnect, isConnected, refreshHookScript } from './setup';
import { LogTail } from './tail';

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Only show agents working on this window's folders.
function belongsHere(ev: HookEvent): boolean {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (!roots.length) return false;
  const file = resolveFile(ev);
  if (file) return roots.some((r) => inside(file, r));
  if (!ev.cwd) return false;
  return roots.some((r) => inside(ev.cwd!, r) || inside(r, ev.cwd!));
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const model = createModel();
  const config = () => vscode.workspace.getConfiguration('agentCursor');
  let connected = isConnected();
  let lastUserAt = 0;
  let followed: { key: string; file?: string; line?: number } | undefined;

  refreshHookScript(context.extensionPath);

  const editorView = new EditorView(context.globalStorageUri.fsPath);
  const badges = new ExplorerBadges(model);
  const panel = new AgentPanel(context.extensionUri, model, {
    follow: () => config().get<boolean>('follow', false),
    setFollow: (on) => config().update('follow', on, vscode.ConfigurationTarget.Global),
    connected: () => connected,
    connect: () => vscode.commands.executeCommand('agentCursor.connect'),
    demo: () => vscode.commands.executeCommand('agentCursor.demo'),
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'agentCursor.showPanel';

  function lead(): Agent | undefined {
    const all = [...model.agents.values()];
    return (
      all.filter((a) => isBusy(a) && !a.parentKey).sort((a, b) => b.lastAt - a.lastAt)[0] ??
      all.filter(isBusy).sort((a, b) => b.lastAt - a.lastAt)[0]
    );
  }

  function renderStatus() {
    const a = lead();
    if (!a) {
      const any = model.agents.size > 0;
      status.text = '$(sparkle) Agent Cursor';
      status.tooltip = any ? 'Agents are idle' : connected ? 'Waiting for Claude Code' : 'Claude Code not connected';
      status.color = undefined;
    } else {
      const others = [...model.agents.values()].filter((x) => x !== a && isBusy(x)).length;
      status.text = `$(sparkle) ${a.label} · ${a.detail}${others ? ` +${others}` : ''}`;
      status.tooltip = 'Show the Agent panel';
      status.color = colorOf(a.colorIndex);
    }
    status.show();
  }

  async function follow() {
    if (!config().get<boolean>('follow', false)) return;
    const a = lead();
    if (!a?.file || a.line === undefined) return;
    if (followed && followed.key === a.key && followed.file === a.file && followed.line === a.line) return;
    if (Date.now() - lastUserAt < 2500) return; // don't pull the editor away while someone's typing
    followed = { key: a.key, file: a.file, line: a.line };
    try {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(a.file), { preview: true, preserveFocus: true });
      const line = Math.min(a.line, editor.document.lineCount - 1);
      editor.revealRange(new vscode.Range(line, 0, a.endLine ?? line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      // file may be gone
    }
  }

  function redraw() {
    editorView.render(model, Date.now());
    badges.refresh();
    panel.update();
    renderStatus();
    follow();
  }

  function feed(ev: HookEvent, check = true) {
    if (check && !belongsHere(ev)) return;
    if (apply(model, ev, readText)) redraw();
  }

  const tail = new LogTail(LOG_FILE, (line) => {
    try {
      feed(JSON.parse(line));
    } catch {
      // skip a bad line
    }
  });
  tail.start();

  // animation clock: pulse the markers and fade the glow
  const clock = setInterval(() => {
    const now = Date.now();
    const changed = tick(model, now);
    const moving = model.changes.length > 0 || [...model.agents.values()].some(isBusy);
    if (moving || changed) editorView.render(model, now);
    if (changed) {
      badges.refresh();
      panel.update();
      renderStatus();
    }
  }, 380);

  let demoTimers: NodeJS.Timeout[] = [];

  context.subscriptions.push(
    editorView,
    badges,
    panel,
    status,
    { dispose: () => tail.dispose() },
    { dispose: () => clearInterval(clock) },
    { dispose: () => demoTimers.forEach(clearTimeout) },
    vscode.window.registerWebviewViewProvider(AgentPanel.id, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeVisibleTextEditors(() => editorView.render(model, Date.now())),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse) lastUserAt = Date.now();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentCursor.follow')) {
        followed = undefined;
        panel.update();
        follow();
      }
    }),
    vscode.commands.registerCommand('agentCursor.showPanel', () => panel.reveal()),
    vscode.commands.registerCommand('agentCursor.toggleFollow', async () => {
      const on = !config().get<boolean>('follow', false);
      await config().update('follow', on, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(on ? 'Agent Cursor: following the agent' : 'Agent Cursor: follow off', 2500);
    }),
    vscode.commands.registerCommand('agentCursor.connect', async () => {
      if (await connect(context.extensionPath)) {
        connected = true;
        panel.update();
        renderStatus();
      }
    }),
    vscode.commands.registerCommand('agentCursor.disconnect', async () => {
      await disconnect();
      connected = isConnected();
      panel.update();
      renderStatus();
    }),
    vscode.commands.registerCommand('agentCursor.demo', async () => {
      const files = await pickDemoFiles();
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!files.length || !root) {
        vscode.window.showInformationMessage('Open a folder with a few code files to run the demo.');
        return;
      }
      demoTimers.forEach(clearTimeout);
      for (const [k, a] of model.agents) if (a.sid === 'agent-cursor-demo') model.agents.delete(k);
      panel.reveal();
      const start = Date.now() + 300;
      demoTimers = demoScript(files, root, start).map((ev) =>
        setTimeout(() => feed({ ...ev, t: Date.now() }, false), ev.t - Date.now()),
      );
      demoTimers.push(
        setTimeout(() => {
          for (const [k, a] of model.agents) if (a.sid === 'agent-cursor-demo') model.agents.delete(k);
          for (const [f, t] of model.touched) if (t.agentKey.startsWith('agent-cursor-demo')) model.touched.delete(f);
          model.feed = model.feed.filter((x) => !x.agentKey.startsWith('agent-cursor-demo'));
          redraw();
        }, start - Date.now() + 26_000),
      );
    }),
  );

  renderStatus();

  if (!connected && !context.globalState.get('agentCursor.welcomed')) {
    context.globalState.update('agentCursor.welcomed', true);
    vscode.window
      .showInformationMessage('Agent Cursor shows where Claude Code is working in your files. Connect it now?', 'Connect', 'Try the demo')
      .then((pick) => {
        if (pick === 'Connect') vscode.commands.executeCommand('agentCursor.connect');
        if (pick === 'Try the demo') vscode.commands.executeCommand('agentCursor.demo');
      });
  }
}

export function deactivate() {}
