// Add or remove Agent Cursor's hooks in an agent's hook config, leaving every
// other hook and setting untouched. Two config shapes cover the agents:
//   nested: { hooks: { Event: [ { matcher, hooks: [ { type: 'command', command } ] } ] } }  (Claude Code, Codex, Gemini, Qwen...)
//   flat:   { hooks: { event: [ { command } ] } }                                         (Cursor, Copilot...)

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
export const MARK = 'agent-cursor';

function isOurs(hook: any): boolean {
  if (!hook) return false;
  const cmd = [hook.command, hook.bash, hook.powershell].filter((c) => typeof c === 'string').join(' ');
  return cmd.includes(MARK);
}

export interface HookSpec {
  shape: 'nested' | 'flat';
  events: readonly string[];
  toolEvents?: readonly string[]; // get a match-everything matcher
  matcher?: string; // what "every tool" looks like for this agent
  hookFields?: Record<string, unknown>; // e.g. { async: true, timeout: 10 }
  flatField?: string; // flat shape: the key that holds the command (command / bash)
  root?: Record<string, unknown>; // fields the file itself needs, e.g. { version: 1 }
}

export const CLAUDE_SPEC: HookSpec = {
  shape: 'nested',
  events: HOOK_EVENTS,
  toolEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  matcher: '*',
  hookFields: { async: true, timeout: 10 },
};

function groupHasOurs(g: any): boolean {
  if (!g) return false;
  if (Array.isArray(g.hooks)) return g.hooks.some(isOurs);
  return isOurs(g);
}

export function removeHooks(settings: any): any {
  const out = { ...(settings ?? {}) };
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  const hooks: any = {};
  for (const [event, groups] of Object.entries<any>(out.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map((g: any) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
      .filter((g: any) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0))
      .filter((g: any) => !(g && !Array.isArray(g.hooks) && isOurs(g)));
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

export function addHooks(settings: any, command: string, spec: HookSpec = CLAUDE_SPEC): any {
  const out = removeHooks(settings);
  if (spec.root) for (const [k, v] of Object.entries(spec.root)) if (out[k] === undefined) out[k] = v;
  const hooks: any = { ...(out.hooks ?? {}) };
  for (const event of spec.events) {
    let group: any;
    if (spec.shape === 'flat') {
      group = { [spec.flatField ?? 'command']: command, ...(spec.hookFields ?? {}) };
    } else {
      group = { hooks: [{ type: 'command', command, ...(spec.hookFields ?? {}) }] };
      if (spec.toolEvents?.includes(event) && spec.matcher !== undefined) group.matcher = spec.matcher;
    }
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
  }
  out.hooks = hooks;
  return out;
}

export function hasHooks(settings: any): boolean {
  const all = settings?.hooks;
  if (!all || typeof all !== 'object') return false;
  return Object.values<any>(all).some((groups) => Array.isArray(groups) && groups.some(groupHasOurs));
}

// Quote a path for the shell Claude Code runs hooks in (bash, or PowerShell on Windows).
export function hookCommand(node: string, script: string): string {
  const q = (s: string) => (/[\s"'$`]/.test(s) ? `"${s.replace(/(["$`\\])/g, '\\$1')}"` : s);
  return `${q(node)} ${q(script)}`;
}
