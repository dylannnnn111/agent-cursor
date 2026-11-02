// Agent Cursor plugin for OpenCode (and Kilo Code, an OpenCode fork).
// Installed by "Agent Cursor: Connect an agent" into OpenCode's plugin folder.
// It only watches: it appends what each tool call touched to
// ~/.agent-cursor/events.jsonl and never changes or blocks anything.
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const LOG = process.env.AGENT_CURSOR_LOG || join(homedir(), '.agent-cursor', 'events.jsonl');
const AGENT = 'opencode';
const clip = (v, n = 4000) => (typeof v === 'string' ? v.slice(0, n) : undefined);

function write(ev) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    try {
      if (statSync(LOG).size > 2 * 1024 * 1024) renameSync(LOG, LOG + '.old');
    } catch {}
    appendFileSync(LOG, JSON.stringify(ev) + '\n');
  } catch {}
}

function toEvent(phase, input, args, directory) {
  const tool = String(input?.tool || '').toLowerCase();
  const a = args || {};
  const file = a.filePath || a.path || a.file_path;
  const out = { t: Date.now(), agent: AGENT, ev: phase, sid: input?.sessionID || 'opencode', cwd: directory, tuid: input?.callID };
  if (tool === 'read') return { ...out, tool: 'Read', input: { file_path: file, offset: a.offset, limit: a.limit } };
  if (tool === 'edit') return { ...out, tool: 'Edit', input: { file_path: file, old_string: clip(a.oldString), new_string: clip(a.newString) } };
  if (tool === 'write') return { ...out, tool: 'Write', input: { file_path: file, content_lines: typeof a.content === 'string' ? a.content.split('\n').length : undefined } };
  if (tool === 'bash' || tool === 'shell') return { ...out, tool: 'Bash', input: { command: clip(a.command, 300), description: clip(a.description, 120) } };
  if (tool === 'grep' || tool === 'glob' || tool === 'list') return { ...out, tool: 'Grep', input: { pattern: clip(a.pattern || a.path, 80) } };
  if (tool === 'webfetch') return { ...out, tool: 'WebFetch', input: { url: clip(a.url, 200) } };
  if (tool === 'task') return { ...out, tool: 'Task', input: { description: clip(a.description, 120) } };
  return { ...out, tool: input?.tool || 'tool' };
}

export const AgentCursor = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    write(toEvent('PreToolUse', input, output?.args, directory));
  },
  'tool.execute.after': async (input, output) => {
    write(toEvent('PostToolUse', input, output?.args ?? input?.args, directory));
  },
  event: async ({ event }) => {
    const sid = event?.properties?.sessionID || event?.properties?.info?.id;
    if (event?.type === 'session.idle' && sid) write({ t: Date.now(), agent: AGENT, ev: 'Stop', sid, cwd: directory });
  },
});
