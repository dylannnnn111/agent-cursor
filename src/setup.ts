// Connect / disconnect coding agents: install the hook script (or plugin) and
// add it to that agent's config. Only runs when the person asks.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentSetup, SETUPS, addTomlBlocks, hasTomlBlocks, homeDir, removeTomlBlocks, setupFor } from './core/agents';
import { kindOf } from './core/kinds';
import { addHooks, hasHooks, hookCommand, removeHooks } from './core/settings';

export const HOME_DIR = path.join(os.homedir(), '.agent-cursor');
export const LOG_FILE = process.env.AGENT_CURSOR_LOG || path.join(HOME_DIR, 'events.jsonl');
const HOOK_FILE = path.join(HOME_DIR, 'hook.js');
const HOOK_FILES = ['hook.js', 'adapters.js'];

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

function buildCommand(agent: string): string | undefined {
  const node = findNode();
  if (node) return `${hookCommand(node, HOOK_FILE)} --agent ${agent}`;
  // No Node on the machine: VS Code's own runtime can run the script.
  if (process.platform !== 'win32') return `ELECTRON_RUN_AS_NODE=1 ${hookCommand(process.execPath, HOOK_FILE)} --agent ${agent}`;
  return undefined;
}

function installHookScripts(extensionPath: string) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  for (const f of HOOK_FILES) fs.copyFileSync(path.join(extensionPath, 'hook', f), path.join(HOME_DIR, f));
}

function backupOnce(file: string) {
  const backup = file + '.agent-cursor-backup';
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
}

function writeFile(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  fs.writeFileSync(file, text);
}

function projectRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

// every config file of this agent that could hold our hooks
function candidateFiles(s: AgentSetup): string[] {
  const home = homeDir();
  const files = [s.userFile(home)];
  if (s.projectFile) for (const r of projectRoots()) files.push(s.projectFile(r));
  return files;
}

function fileHasOurs(s: AgentSetup, file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    if (s.format === 'plugin-file') return true;
    const text = fs.readFileSync(file, 'utf8');
    if (s.format === 'toml-blocks') return hasTomlBlocks(text);
    const json = JSON.parse(text || '{}');
    return hasHooks(json);
  } catch {
    return false;
  }
}

export function connectedAgents(): string[] {
  return SETUPS.filter((s) => candidateFiles(s).some((f) => fileHasOurs(s, f))).map((s) => s.id);
}

export function isConnected(): boolean {
  return connectedAgents().length > 0;
}

function connectFile(s: AgentSetup, file: string, command: string, extensionPath: string): string | undefined {
  switch (s.format) {
    case 'plugin-file':
      writeFile(file, fs.readFileSync(path.join(extensionPath, 'hook', 'opencode-plugin.js'), 'utf8'));
      return undefined;
    case 'toml-blocks': {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      writeFile(file, addTomlBlocks(text, command, s.tomlEvents ?? []));
      return undefined;
    }
    default: {
      const current = s.format === 'json-own-file' ? {} : readJson(file);
      if (current === undefined) return `Couldn't read ${file} - it isn't valid JSON. Fix it, then try again.`;
      let next = addHooks(current, command, s.spec);
      if (s.id === 'copilot') {
        // Copilot runs `bash` on macOS/Linux and `powershell` on Windows
        for (const groups of Object.values<any>(next.hooks)) for (const g of groups) if (g.bash === command) g.powershell = command;
      }
      writeFile(file, JSON.stringify(next, null, 2) + '\n');
      if (s.id === 'codex') {
        const toml = path.join(path.dirname(file), 'config.toml');
        if (fs.existsSync(toml) && /^\s*\[\[?hooks/m.test(fs.readFileSync(toml, 'utf8'))) {
          return 'Heads up: your ~/.codex/config.toml also has [hooks]. Codex wants hooks in one place per folder, so move them into hooks.json.';
        }
      }
      return undefined;
    }
  }
}

function disconnectFile(s: AgentSetup, file: string) {
  if (!fileHasOurs(s, file)) return;
  if (s.format === 'plugin-file' || s.format === 'json-own-file') {
    fs.renameSync(file, file + '.removed'); // keep a copy instead of deleting
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (s.format === 'toml-blocks') {
    writeFile(file, removeTomlBlocks(text));
    return;
  }
  writeFile(file, JSON.stringify(removeHooks(JSON.parse(text || '{}')), null, 2) + '\n');
}

async function pickAgents(title: string, only?: string[]): Promise<AgentSetup[] | undefined> {
  const home = homeDir();
  const connected = new Set(connectedAgents());
  const list = SETUPS.filter((s) => !only || only.includes(s.id));
  const items = list.map((s) => {
    const installed = fs.existsSync(s.detect(home));
    return {
      label: `${kindOf(s.id).glyph}  ${s.label}`,
      description: connected.has(s.id) ? 'connected' : installed ? 'installed' : 'not found on this machine',
      detail: s.detail,
      picked: !only && installed && !connected.has(s.id),
      setup: s,
    };
  });
  const picks = await vscode.window.showQuickPick(items, { title, canPickMany: true, placeHolder: 'Pick the agents you use' });
  return picks?.map((p) => p.setup);
}

export async function connect(extensionPath: string, preselect?: string): Promise<boolean> {
  const chosen = preselect ? [setupFor(preselect)!].filter(Boolean) : await pickAgents('Agent Cursor: Connect coding agents');
  if (!chosen?.length) return false;
  installHookScripts(extensionPath);
  const notes: string[] = [];
  for (const s of chosen) {
    const command = buildCommand(s.id);
    if (!command && s.format !== 'plugin-file') {
      vscode.window.showErrorMessage('Agent Cursor needs Node.js to run its hook. Install Node, then try again.');
      return false;
    }
    let file = s.userFile(homeDir());
    if (s.id === 'claude' && s.projectFile && projectRoots().length && !preselect) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'All projects', description: '~/.claude/settings.json', file },
          ...projectRoots().map((r) => ({ label: `Only ${path.basename(r)}`, description: '.claude/settings.local.json (not committed)', file: s.projectFile!(r) })),
        ],
        { title: 'Claude Code: which settings?' },
      );
      if (!pick) continue;
      file = pick.file;
    }
    const warn = connectFile(s, file, command ?? '', extensionPath);
    if (warn?.startsWith("Couldn't")) {
      vscode.window.showErrorMessage(warn);
      continue;
    }
    notes.push(`${s.label}: ${s.after}${warn ? ' ' + warn : ''}`);
  }
  if (!notes.length) return false;
  if (notes.length === 1) vscode.window.showInformationMessage(`Agent Cursor connected. ${notes[0]}`);
  else vscode.window.showInformationMessage(`Agent Cursor connected ${notes.length} agents. ${notes.join(' ')}`, { modal: false });
  return true;
}

export async function disconnect(): Promise<void> {
  const connected = connectedAgents();
  if (!connected.length) {
    vscode.window.showInformationMessage('Agent Cursor isn’t connected to any coding agent.');
    return;
  }
  const chosen = await pickAgents('Agent Cursor: Disconnect coding agents', connected);
  if (!chosen?.length) return;
  for (const s of chosen) for (const f of candidateFiles(s)) disconnectFile(s, f);
  vscode.window.showInformationMessage(`Removed Agent Cursor from ${chosen.map((s) => s.label).join(', ')}. Your own hooks are untouched.`);
}

// keep the installed hook in step with the extension version
export function refreshHookScript(extensionPath: string) {
  try {
    if (fs.existsSync(HOOK_FILE)) installHookScripts(extensionPath);
    const oc = setupFor('opencode')!;
    const ocFile = oc.userFile(homeDir());
    if (fs.existsSync(ocFile)) fs.copyFileSync(path.join(extensionPath, 'hook', 'opencode-plugin.js'), ocFile);
  } catch {
    // not fatal
  }
}
