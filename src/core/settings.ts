// Add or remove Agent Cursor's hooks in a Claude Code settings object,
// leaving every other hook and setting untouched.

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
  return !!hook && typeof hook.command === 'string' && hook.command.includes(MARK);
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
      .filter((g: any) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

export function addHooks(settings: any, command: string): any {
  const out = removeHooks(settings);
  const hooks: any = { ...(out.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const group: any = { hooks: [{ type: 'command', command, async: true, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) group.matcher = '*';
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
  }
  out.hooks = hooks;
  return out;
}

export function hasHooks(settings: any): boolean {
  const groups = settings?.hooks?.PreToolUse;
  return Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some(isOurs));
}

// Quote a path for the shell Claude Code runs hooks in (bash, or PowerShell on Windows).
export function hookCommand(node: string, script: string): string {
  const q = (s: string) => (/[\s"'$`]/.test(s) ? `"${s.replace(/(["$`\\])/g, '\\$1')}"` : s);
  return `${q(node)} ${q(script)}`;
}
