// The live picture of what each agent is doing, built from hook events.
// No VS Code imports here, so it can be tested with plain Node.

import * as path from 'path';
import { countLines, locate, LineRange } from './locate';
import { kindOf, shadeOf, shapePath } from './kinds';

export type Activity =
  | 'reading'
  | 'editing'
  | 'writing'
  | 'searching'
  | 'running'
  | 'browsing'
  | 'delegating'
  | 'working'
  | 'thinking'
  | 'idle';

export interface HookEvent {
  t: number;
  ev: string;
  sid: string;
  cwd?: string;
  aid?: string;
  atype?: string;
  tool?: string;
  tuid?: string;
  input?: Record<string, any>;
  hunks?: { newStart: number; newLines: number }[];
  prompt?: string;
  agent?: string; // which coding agent sent it (claude, codex, gemini...); missing = claude
  model?: string;
}

export interface Agent {
  key: string;
  sid: string;
  aid?: string;
  parentKey?: string;
  label: string;
  kind: string;
  shade: number;
  color: string;
  model?: string;
  activity: Activity;
  detail: string;
  file?: string;
  line?: number;
  endLine?: number;
  startedAt: number;
  lastAt: number;
  doneAt?: number;
}

export interface Change {
  agentKey: string;
  kind: string;
  color: string;
  shade: number;
  file: string;
  start: number;
  end: number;
  at: number;
}

export interface FeedItem {
  at: number;
  agentKey: string;
  kind: string;
  color: string;
  label: string;
  activity: Activity;
  text: string;
  file?: string;
  line?: number;
}

export interface Touch {
  read: boolean;
  edited: boolean;
  agentKey: string;
  kind: string;
  color: string;
  at: number;
}

export interface Model {
  agents: Map<string, Agent>;
  changes: Change[];
  feed: FeedItem[];
  touched: Map<string, Touch>;
  pending: Map<string, LineRange>; // edit location found before the edit, by tool_use_id
  sessions: number;
}

export const FADE_MS = 10_000;
export const IDLE_MS = 90_000;
export const SUBAGENT_LINGER_MS = 4_000;
const MAX_FEED = 80;
const MAX_CHANGES = 300;
const MAX_HIGHLIGHT_LINES = 400;

export type ReadText = (file: string) => string | undefined;

export function createModel(): Model {
  return { agents: new Map(), changes: [], feed: [], touched: new Map(), pending: new Map(), sessions: 0 };
}

function keyOf(ev: HookEvent): string {
  return ev.aid ? `${ev.sid}:${ev.aid}` : ev.sid;
}

export const DEMO_SID = 'agent-cursor-demo';

// Lowest free number among this agent type's sessions on screen, so a fresh
// session after the others have ended is "Claude" again rather than "Claude 4".
function sessionNumber(m: Model, kind: string): number {
  const used = new Set<number>();
  for (const a of m.agents.values()) if (!a.parentKey && a.kind === kind && !a.sid.startsWith(DEMO_SID)) used.add(labelNumber(a.label));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function labelNumber(label: string): number {
  const m = /(\d+)$/.exec(label);
  return m ? Number(m[1]) : 1;
}

function ensureSession(m: Model, ev: HookEvent): Agent {
  let a = m.agents.get(ev.sid);
  if (!a) {
    m.sessions++;
    const kind = kindOf(ev.agent ?? 'claude').id;
    const demo = ev.sid.startsWith(DEMO_SID);
    const n = demo ? 1 : sessionNumber(m, kind);
    const name = kindOf(kind).name;
    a = {
      key: ev.sid,
      sid: ev.sid,
      label: demo ? `${name} (demo)` : n === 1 ? name : `${name} ${n}`,
      kind,
      shade: (n - 1) % 3,
      color: shadeOf(kind, n - 1),
      activity: 'idle',
      detail: 'Waiting',
      startedAt: ev.t,
      lastAt: ev.t,
    };
    m.agents.set(a.key, a);
  }
  if (ev.model && !a.model) a.model = ev.model;
  return a;
}

function ensureAgent(m: Model, ev: HookEvent): Agent {
  const parent = ensureSession(m, ev);
  if (!ev.aid) return parent;
  const key = keyOf(ev);
  let a = m.agents.get(key);
  if (!a) {
    const siblings = [...m.agents.values()].filter((x) => x.parentKey === parent.key).length;
    const shade = parent.shade + 1 + siblings;
    a = {
      key,
      sid: ev.sid,
      aid: ev.aid,
      parentKey: parent.key,
      label: ev.atype ? `${parent.label} › ${ev.atype}` : `${parent.label} › subagent`,
      kind: parent.kind,
      shade: shade % 3,
      color: shadeOf(parent.kind, shade),
      activity: 'thinking',
      detail: 'Starting',
      startedAt: ev.t,
      lastAt: ev.t,
    };
    m.agents.set(key, a);
  }
  return a;
}

export function resolveFile(ev: HookEvent): string | undefined {
  const p = ev.input?.file_path ?? ev.input?.notebook_path;
  if (typeof p !== 'string' || !p) return undefined;
  if (path.isAbsolute(p)) return path.normalize(p);
  return ev.cwd ? path.resolve(ev.cwd, p) : undefined;
}

function base(file: string | undefined): string {
  return file ? path.basename(file) : '';
}

function short(s: unknown, n = 60): string {
  const v = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

function linesLabel(start: number, end: number): string {
  return start === end ? `line ${start + 1}` : `lines ${start + 1}-${end + 1}`;
}

function push(m: Model, a: Agent, at: number, text: string) {
  m.feed.unshift({
    at,
    agentKey: a.key,
    kind: a.kind,
    color: a.color,
    label: a.label,
    activity: a.activity,
    text,
    file: a.file,
    line: a.line,
  });
  if (m.feed.length > MAX_FEED) m.feed.length = MAX_FEED;
}

function touch(m: Model, a: Agent, file: string, kind: 'read' | 'edited', at: number) {
  const t = m.touched.get(file) ?? { read: false, edited: false, agentKey: a.key, kind: a.kind, color: a.color, at };
  if (kind === 'read') t.read = true;
  else t.edited = true;
  t.agentKey = a.key;
  t.kind = a.kind;
  t.color = a.color;
  t.at = at;
  m.touched.set(file, t);
}

function editTool(tool: string | undefined): boolean {
  return tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit';
}

function beforeTool(m: Model, a: Agent, ev: HookEvent, readText: ReadText) {
  const input = ev.input ?? {};
  const file = resolveFile(ev);
  const tool = ev.tool ?? 'tool';
  switch (tool) {
    case 'Read': {
      if (!file) break;
      const start = Math.max(0, (typeof input.offset === 'number' ? input.offset : 1) - 1);
      const total = countLines(readText(file) ?? '');
      const want = typeof input.limit === 'number' ? input.limit : total;
      a.activity = 'reading';
      a.file = file;
      a.line = Math.min(start, Math.max(0, total - 1));
      a.endLine = Math.min(a.line + Math.max(1, want) - 1, total - 1, a.line + MAX_HIGHLIGHT_LINES);
      a.detail = `Reading ${base(file)}`;
      touch(m, a, file, 'read', ev.t);
      const range = start > 0 || want < total ? ` (${linesLabel(a.line, a.endLine)})` : '';
      push(m, a, ev.t, `Reading ${base(file)}${range}`);
      return;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (!file) break;
      const needle = tool === 'MultiEdit' ? input.edits?.[0]?.old_string : input.old_string;
      const found = locate(readText(file), needle);
      const sameFile = a.file === file;
      a.activity = 'editing';
      a.file = file;
      a.line = found?.start ?? (sameFile ? a.line ?? 0 : 0);
      a.endLine = found?.end ?? a.line;
      if (found && ev.tuid) m.pending.set(ev.tuid, found);
      a.detail = `Editing ${base(file)}`;
      push(m, a, ev.t, found ? `Editing ${base(file)} (${linesLabel(found.start, found.end)})` : `Editing ${base(file)}`);
      return;
    }
    case 'Write': {
      if (!file) break;
      a.activity = 'writing';
      a.file = file;
      a.line = 0;
      a.endLine = 0;
      a.detail = `Writing ${base(file)}`;
      push(m, a, ev.t, `Writing ${base(file)}`);
      return;
    }
    case 'Grep':
    case 'Glob': {
      a.activity = 'searching';
      const what = short(input.pattern, 40);
      a.detail = what ? `Searching for “${what}”` : 'Searching';
      push(m, a, ev.t, a.detail);
      return;
    }
    case 'Bash': {
      a.activity = 'running';
      a.detail = `Running ${short(input.description || input.command, 50)}`;
      push(m, a, ev.t, `Running \`${short(input.command, 70)}\``);
      return;
    }
    case 'Task':
    case 'Agent': {
      a.activity = 'delegating';
      a.detail = `Handing off: ${short(input.description || input.subagent_type, 40)}`;
      push(m, a, ev.t, a.detail);
      return;
    }
    case 'WebFetch':
    case 'WebSearch': {
      a.activity = 'browsing';
      a.detail = tool === 'WebSearch' ? `Searching the web for “${short(input.query, 40)}”` : `Reading ${short(input.url, 50)}`;
      push(m, a, ev.t, a.detail);
      return;
    }
  }
  a.activity = 'working';
  a.detail = `Using ${tool.replace(/^mcp__/, '').replace(/__/g, ' › ')}`;
  push(m, a, ev.t, a.detail);
}

function afterTool(m: Model, a: Agent, ev: HookEvent, readText: ReadText, failed: boolean) {
  const tool = ev.tool;
  const file = resolveFile(ev);
  const pre = ev.tuid ? m.pending.get(ev.tuid) : undefined;
  if (ev.tuid) m.pending.delete(ev.tuid);

  if (failed) {
    push(m, a, ev.t, `${tool ?? 'Tool'} failed${file ? ` on ${base(file)}` : ''}`);
  } else if (file && editTool(tool)) {
    const ranges: LineRange[] = [];
    if (ev.hunks?.length) {
      for (const h of ev.hunks) {
        const start = Math.max(0, h.newStart - 1);
        ranges.push({ start, end: start + Math.max(1, h.newLines) - 1 });
      }
    } else if (tool === 'Write') {
      const n = typeof ev.input?.content_lines === 'number' ? ev.input.content_lines : countLines(readText(file) ?? '');
      ranges.push({ start: 0, end: Math.max(0, Math.min(n, MAX_HIGHLIGHT_LINES) - 1) });
    } else {
      const text = readText(file);
      const edits = tool === 'MultiEdit' ? ev.input?.edits ?? [] : [ev.input ?? {}];
      for (const e of edits) {
        const r = e.new_string ? locate(text, e.new_string) : undefined;
        if (r) ranges.push(r);
      }
      if (!ranges.length && pre) ranges.push({ start: pre.start, end: pre.start });
    }
    for (const r of ranges) {
      m.changes.push({
        agentKey: a.key,
        kind: a.kind,
        color: a.color,
        shade: a.shade,
        file,
        start: r.start,
        end: Math.min(r.end, r.start + MAX_HIGHLIGHT_LINES),
        at: ev.t,
      });
    }
    if (m.changes.length > MAX_CHANGES) m.changes.splice(0, m.changes.length - MAX_CHANGES);
    touch(m, a, file, 'edited', ev.t);
    a.file = file;
    if (ranges.length) {
      a.line = ranges[0].start;
      a.endLine = ranges[0].end;
      const where = ranges.length > 1 ? `${ranges.length} places` : linesLabel(ranges[0].start, ranges[0].end);
      push(m, a, ev.t, `${tool === 'Write' ? 'Wrote' : 'Changed'} ${base(file)} (${where})`);
    }
  }
  // the spot stays where it was, the agent is back to thinking
  a.activity = 'thinking';
  a.detail = 'Thinking';
}

export function apply(m: Model, ev: HookEvent, readText: ReadText): boolean {
  if (!ev || typeof ev.sid !== 'string' || typeof ev.ev !== 'string') return false;
  const t = typeof ev.t === 'number' ? ev.t : Date.now();
  ev.t = t;
  switch (ev.ev) {
    case 'SessionStart': {
      const a = ensureSession(m, ev);
      a.activity = 'idle';
      a.detail = 'Ready';
      a.lastAt = t;
      return true;
    }
    case 'SessionEnd': {
      for (const [k, a] of m.agents) if (a.sid === ev.sid) m.agents.delete(k);
      return true;
    }
    case 'UserPromptSubmit': {
      const a = ensureSession(m, ev);
      a.activity = 'thinking';
      a.detail = 'Thinking';
      a.lastAt = t;
      push(m, a, t, ev.prompt ? `New prompt: “${short(ev.prompt, 70)}”` : 'New prompt');
      return true;
    }
    case 'SubagentStart': {
      const a = ensureAgent(m, ev);
      a.lastAt = t;
      push(m, a, t, 'Started');
      return true;
    }
    case 'SubagentStop': {
      const a = ev.aid ? m.agents.get(keyOf(ev)) : undefined;
      if (!a) return false;
      a.activity = 'idle';
      a.detail = 'Finished';
      a.doneAt = t;
      a.lastAt = t;
      push(m, a, t, 'Finished');
      return true;
    }
    case 'Stop': {
      const a = ensureSession(m, ev);
      a.activity = 'idle';
      a.detail = 'Done';
      a.lastAt = t;
      push(m, a, t, 'Done');
      return true;
    }
    case 'PreToolUse': {
      const a = ensureAgent(m, ev);
      a.lastAt = t;
      beforeTool(m, a, ev, readText);
      return true;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const a = ensureAgent(m, ev);
      a.lastAt = t;
      afterTool(m, a, ev, readText, ev.ev === 'PostToolUseFailure');
      return true;
    }
  }
  return false;
}

// Time-based clean-up: fade changes, mark quiet agents idle, drop finished subagents.
export function tick(m: Model, now: number): boolean {
  let changed = false;
  const before = m.changes.length;
  m.changes = m.changes.filter((c) => now - c.at < FADE_MS);
  if (m.changes.length !== before) changed = true;
  for (const [k, a] of m.agents) {
    if (a.doneAt && now - a.doneAt > SUBAGENT_LINGER_MS) {
      m.agents.delete(k);
      changed = true;
    } else if (a.activity !== 'idle' && now - a.lastAt > IDLE_MS) {
      a.activity = 'idle';
      a.detail = 'Quiet';
      changed = true;
    }
  }
  return changed;
}

export function isBusy(a: Agent): boolean {
  return a.activity !== 'idle';
}

// Plain data for the sidebar panel.
export function snapshot(m: Model, now: number) {
  return {
    now,
    agents: [...m.agents.values()].map((a) => ({
      key: a.key,
      label: a.label,
      kind: a.kind,
      color: a.color,
      model: a.model,
      shape: shapePath(kindOf(a.kind).shape),
      activity: a.activity,
      detail: a.detail,
      file: a.file,
      line: a.line,
      sub: !!a.parentKey,
    })),
    touched: [...m.touched.entries()].map(([file, t]) => ({ file, ...t })),
    feed: m.feed.slice(0, 40).map((f) => ({ ...f, shape: shapePath(kindOf(f.kind).shape) })),
  };
}
