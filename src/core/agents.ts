// How Agent Cursor connects to each coding agent: which config file, what
// shape, which events. Pure data + helpers, so it can be tested in plain Node.
//
// Rule: we only hook events where printing nothing (or "{}") changes nothing.
// Agents whose *before* hooks expect an allow/deny answer (Cursor, Copilot,
// Gemini) only get *after* hooks, so Agent Cursor can never approve or block
// anything on the user's behalf.

import * as os from 'os';
import * as path from 'path';
import { CLAUDE_SPEC, HookSpec, MARK } from './settings';

export type Format = 'json' | 'json-own-file' | 'toml-blocks' | 'plugin-file';

export interface AgentSetup {
  id: string; // matches the kind id in kinds.ts
  label: string;
  detail: string;
  format: Format;
  userFile: (home: string) => string;
  projectFile?: (root: string) => string;
  spec?: HookSpec;
  tomlEvents?: string[];
  after: string; // what to tell the person once connected
  detect: (home: string) => string; // a folder that exists if the agent is installed
}

const H = (home: string, ...p: string[]) => path.join(home, ...p);

export const SETUPS: AgentSetup[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    detail: '~/.claude/settings.json',
    format: 'json',
    userFile: (h) => H(process.env.CLAUDE_CONFIG_DIR || H(h, '.claude'), 'settings.json'),
    projectFile: (r) => path.join(r, '.claude', 'settings.local.json'),
    spec: CLAUDE_SPEC,
    after: 'Start a new Claude Code session (restart any that are running).',
    detect: (h) => H(h, '.claude'),
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    detail: '~/.codex/hooks.json',
    format: 'json',
    userFile: (h) => H(process.env.CODEX_HOME || H(h, '.codex'), 'hooks.json'),
    spec: {
      shape: 'nested',
      events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'],
      toolEvents: ['PreToolUse', 'PostToolUse'],
      matcher: '*',
      hookFields: { async: true, timeout: 10 },
    },
    after: 'Start Codex, run /hooks and trust the Agent Cursor hook (Codex won’t run new hooks until you do).',
    detect: (h) => H(h, '.codex'),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detail: '~/.gemini/settings.json',
    format: 'json',
    userFile: (h) => H(h, '.gemini', 'settings.json'),
    projectFile: (r) => path.join(r, '.gemini', 'settings.json'),
    spec: {
      shape: 'nested',
      events: ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'SessionEnd'],
      toolEvents: ['AfterTool'],
      matcher: '.*',
      hookFields: { name: MARK, timeout: 5000 },
    },
    after: 'Start a new Gemini CLI session. It may ask you to confirm the new hook the first time.',
    detect: (h) => H(h, '.gemini'),
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    detail: '~/.qwen/settings.json',
    format: 'json',
    userFile: (h) => H(h, '.qwen', 'settings.json'),
    projectFile: (r) => path.join(r, '.qwen', 'settings.json'),
    spec: {
      shape: 'nested',
      events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'],
      toolEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
      matcher: '.*',
      hookFields: { async: true, timeout: 10000 },
    },
    after: 'Start a new Qwen Code session.',
    detect: (h) => H(h, '.qwen'),
  },
  {
    id: 'cursor',
    label: 'Cursor (agent + CLI)',
    detail: '~/.cursor/hooks.json',
    format: 'json',
    userFile: (h) => H(h, '.cursor', 'hooks.json'),
    projectFile: (r) => path.join(r, '.cursor', 'hooks.json'),
    spec: {
      shape: 'flat',
      root: { version: 1 },
      events: ['sessionStart', 'postToolUse', 'postToolUseFailure', 'afterFileEdit', 'subagentStop', 'stop', 'sessionEnd'],
      hookFields: { timeout: 10 },
    },
    after: 'Cursor reloads hooks on its own. Start an agent chat in the folder you have open here.',
    detect: (h) => H(h, '.cursor'),
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    detail: '~/.copilot/hooks/agent-cursor.json',
    format: 'json-own-file',
    userFile: (h) => H(h, '.copilot', 'hooks', 'agent-cursor.json'),
    spec: {
      shape: 'flat',
      root: { version: 1 },
      events: ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'postToolUseFailure', 'agentStop', 'sessionEnd'],
      flatField: 'bash',
      hookFields: { type: 'command', timeoutSec: 10 },
    },
    after: 'Start a new Copilot CLI session.',
    detect: (h) => H(h, '.copilot'),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    detail: '~/.config/opencode/plugins/agent-cursor.js',
    format: 'plugin-file',
    userFile: (h) => H(process.env.XDG_CONFIG_HOME || H(h, '.config'), 'opencode', 'plugins', 'agent-cursor.js'),
    after: 'Restart OpenCode so it loads the plugin.',
    detect: (h) => H(process.env.XDG_CONFIG_HOME || H(h, '.config'), 'opencode'),
  },
  {
    id: 'kimi',
    label: 'Kimi Code CLI',
    detail: '~/.kimi-code/config.toml',
    format: 'toml-blocks',
    userFile: (h) => H(h, '.kimi-code', 'config.toml'),
    tomlEvents: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    after: 'Start a new Kimi Code session.',
    detect: (h) => H(h, '.kimi-code'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf (Cascade)',
    detail: '~/.codeium/windsurf/hooks.json',
    format: 'json',
    userFile: (h) => H(h, '.codeium', 'windsurf', 'hooks.json'),
    projectFile: (r) => path.join(r, '.windsurf', 'hooks.json'),
    spec: {
      shape: 'flat',
      events: ['post_read_code', 'post_write_code', 'post_run_command', 'post_cascade_response'],
      hookFields: { show_output: false },
    },
    after: 'Windsurf picks up hooks on its next Cascade run.',
    detect: (h) => H(h, '.codeium', 'windsurf'),
  },
];

export function setupFor(id: string): AgentSetup | undefined {
  return SETUPS.find((s) => s.id === id);
}

export function homeDir(): string {
  return os.homedir();
}

// ---------- TOML (Kimi Code): our hooks live between two marker comments ----------

const BEGIN = '# >>> agent-cursor (managed by the Agent Cursor VS Code extension)';
const END = '# <<< agent-cursor';

function tomlString(s: string): string {
  // literal string when possible, basic string otherwise
  if (!s.includes("'") && !/[\n\r]/.test(s)) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function removeTomlBlocks(text: string): string {
  const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`, 'g');
  return text.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
}

export function addTomlBlocks(text: string, command: string, events: string[]): string {
  const clean = removeTomlBlocks(text).replace(/\s+$/, '');
  const blocks = events.map((e) => `[[hooks]]\nevent = "${e}"\ncommand = ${tomlString(command)}\ntimeout = 10`).join('\n\n');
  return `${clean ? clean + '\n\n' : ''}${BEGIN}\n${blocks}\n${END}\n`;
}

export function hasTomlBlocks(text: string): boolean {
  return text.includes(BEGIN);
}
