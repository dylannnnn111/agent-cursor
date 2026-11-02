// Connect / disconnect Claude Code: install the hook script and add it to a
// Claude Code settings file. Only runs when the person asks.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { addHooks, hasHooks, hookCommand, removeHooks } from './core/settings';

export const HOME_DIR = path.join(os.homedir(), '.agent-cursor');
export const LOG_FILE = process.env.AGENT_CURSOR_LOG || path.join(HOME_DIR, 'events.jsonl');
const HOOK_FILE = path.join(HOME_DIR, 'hook.js');

function userSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function workspaceSettingsPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).flatMap((f) => [
    path.join(f.uri.fsPath, '.claude', 'settings.local.json'),
    path.join(f.uri.fsPath, '.claude', 'settings.json'),
  ]);
}

function readJson(file: string): any | undefined {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function findNode(): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['node'], { encoding: 'utf8', timeout: 3000 }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch {
    // not on PATH
  }
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) if (fs.existsSync(p)) return p;
  return undefined;
}

function buildCommand(): string | undefined {
  const node = findNode();
  if (node) return hookCommand(node, HOOK_FILE);
  // No Node on the machine: VS Code's own runtime can run the script.
  if (process.platform !== 'win32') return `ELECTRON_RUN_AS_NODE=1 ${hookCommand(process.execPath, HOOK_FILE)}`;
  return undefined;
}

export function isConnected(): boolean {
  return [userSettingsPath(), ...workspaceSettingsPaths()].some((f) => {
    const s = fs.existsSync(f) ? readJson(f) : undefined;
    return !!s && hasHooks(s);
  });
}

function installHookScript(extensionPath: string) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.copyFileSync(path.join(extensionPath, 'hook', 'hook.js'), HOOK_FILE);
}

async function pickTarget(verb: string): Promise<string | undefined> {
  const items: (vscode.QuickPickItem & { file: string })[] = [
    { label: 'All projects', description: '~/.claude/settings.json', file: userSettingsPath() },
  ];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    items.push({
      label: `Only ${f.name}`,
      description: '.claude/settings.local.json (not committed)',
      file: path.join(f.uri.fsPath, '.claude', 'settings.local.json'),
    });
  }
  const pick = await vscode.window.showQuickPick(items, { title: `Agent Cursor: ${verb} Claude Code`, placeHolder: 'Which Claude Code settings?' });
  return pick?.file;
}

function writeSettings(file: string, settings: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = file + '.agent-cursor-backup';
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

export async function connect(extensionPath: string): Promise<boolean> {
  const command = buildCommand();
  if (!command) {
    vscode.window.showErrorMessage('Agent Cursor needs Node.js to run its Claude Code hook. Install Node, then try again.');
    return false;
  }
  const file = await pickTarget('Connect');
  if (!file) return false;
  const current = readJson(file);
  if (current === undefined) {
    vscode.window.showErrorMessage(`Couldn't read ${file} - it isn't valid JSON. Fix it, then try again.`);
    return false;
  }
  installHookScript(extensionPath);
  writeSettings(file, addHooks(current, command));
  vscode.window.showInformationMessage(
    'Agent Cursor is connected. Start a new Claude Code session (restart any that are running) and it will show up.',
  );
  return true;
}

export async function disconnect(): Promise<void> {
  const files = [userSettingsPath(), ...workspaceSettingsPaths()].filter((f) => {
    const s = fs.existsSync(f) ? readJson(f) : undefined;
    return !!s && hasHooks(s);
  });
  if (!files.length) {
    vscode.window.showInformationMessage('Agent Cursor isn’t connected to any Claude Code settings.');
    return;
  }
  for (const f of files) writeSettings(f, removeHooks(readJson(f)));
  vscode.window.showInformationMessage(`Removed Agent Cursor's hooks from ${files.length} settings file${files.length > 1 ? 's' : ''}.`);
}

// keep the installed hook in step with the extension version
export function refreshHookScript(extensionPath: string) {
  try {
    if (fs.existsSync(HOOK_FILE)) installHookScript(extensionPath);
  } catch {
    // not fatal
  }
}
