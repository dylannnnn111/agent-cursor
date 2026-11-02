'use strict';
// Turns each coding agent's hook payload into the shape Agent Cursor's
// extension reads (the same names Claude Code uses: PreToolUse/PostToolUse,
// Read/Edit/Write/Bash/Grep...). One payload can become several events, e.g. a
// Codex patch that touches three files.
//
// No dependencies, and every adapter is defensive: unknown fields are ignored,
// and a payload we don't understand produces no events rather than a crash.

const path = require('path');

const MAX_TEXT = 4000;

function clip(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function str(v) {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---------- shared helpers ----------

// Simple read commands in a shell (cat, sed -n, head, nl...) become a Read, so
// agents that read through the shell still show where they're looking.
function readFromShell(command) {
  if (typeof command !== 'string') return undefined;
  let cmd = command.trim();
  // bash -lc '...'  /  sh -c "..."
  const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(cmd);
  if (wrapped) cmd = wrapped[2].trim();
  let headLimit;
  const piped = /\|\s*head(?:\s+-n?\s*(\d+))?\s*$/.exec(cmd);
  if (piped) {
    headLimit = Number(piped[1] || 10);
    cmd = cmd.slice(0, piped.index).trim();
  }
  if (/[|;&><`$]/.test(cmd)) return undefined;
  const words = cmd.match(/'[^']*'|"[^"]*"|\S+/g);
  if (!words) return undefined;
  const unq = (w) => w.replace(/^['"]|['"]$/g, '');
  const prog = path.basename(unq(words[0]));
  const files = words.slice(1).map(unq).filter((w) => !w.startsWith('-') && !/^\d+(,\d+)?p$/.test(w) && !/^[+-]?\d+$/.test(w));
  if (prog === 'sed' && words.includes('-n')) {
    const range = words.map(unq).find((w) => /^\d+(,\d+)?p$/.test(w));
    const file = files[files.length - 1];
    if (!range || !file) return undefined;
    const [a, b] = range.slice(0, -1).split(',').map(Number);
    return { file_path: file, offset: a, limit: (b || a) - a + 1 };
  }
  if (['cat', 'nl', 'bat', 'less', 'more'].includes(prog) && files.length === 1) return headLimit ? { file_path: files[0], offset: 1, limit: headLimit } : { file_path: files[0] };
  if (prog === 'head' && files.length === 1) {
    const n = Number(unq(words.find((w, i) => /^-n?\d+$/.test(unq(w)) || words[i - 1] === '-n') || '-10').replace(/^-n?/, '')) || 10;
    return { file_path: files[0], offset: 1, limit: n };
  }
  if (prog === 'tail' && files.length === 1) return { file_path: files[0] };
  return undefined;
}

function searchFromShell(command) {
  if (typeof command !== 'string') return undefined;
  const m = /^\s*(rg|grep|ag|ack|find|fd)\s+(.*)$/.exec(command);
  if (!m) return undefined;
  const pat = /(['"])(.*?)\1/.exec(m[2]);
  return { pattern: clip(pat ? pat[2] : m[2], 80) };
}

// Codex's apply_patch format:
//   *** Begin Patch
//   *** Update File: src/a.py
//   @@ def foo():
//   -    old
//   +    new
//   *** Add File: src/b.py
//   +line
//   *** End Patch
function parsePatch(text) {
  if (typeof text !== 'string' || !text.includes('*** ')) return [];
  const files = [];
  let cur;
  let hunk;
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line))) {
      cur = { op: m[1].toLowerCase(), file: m[2].trim(), hunks: [], added: [] };
      files.push(cur);
      hunk = undefined;
    } else if (cur && (m = /^\*\*\* Move to: (.+)$/.exec(line))) {
      cur.file = m[1].trim();
    } else if (!cur || line.startsWith('*** ')) {
      continue;
    } else if (cur.op === 'add') {
      if (line.startsWith('+')) cur.added.push(line.slice(1));
    } else if (line.startsWith('@@')) {
      hunk = { old: [], new: [] };
      cur.hunks.push(hunk);
    } else {
      if (!hunk) {
        hunk = { old: [], new: [] };
        cur.hunks.push(hunk);
      }
      const body = line.slice(1);
      if (line.startsWith('-')) hunk.old.push(body);
      else if (line.startsWith('+')) hunk.new.push(body);
      else if (line.startsWith(' ') || line === '') {
        hunk.old.push(body);
        hunk.new.push(body);
      }
    }
  }
  return files;
}

// Unified diff (as some agents report edits): --- a/x +++ b/x @@ -l,c +l,c @@
function hunksFromUnifiedDiff(diff) {
  if (typeof diff !== 'string') return undefined;
  const out = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(diff)) && out.length < 50) out.push({ newStart: Number(m[1]), newLines: m[2] === undefined ? 1 : Number(m[2]) });
  return out.length ? out : undefined;
}

function base(raw, agent, ev) {
  const out = { t: Date.now(), agent, ev, sid: str(raw.session_id) || str(raw.sessionId) || str(raw.conversation_id) || str(raw.sessionID) || `${agent}-session` };
  const cwd = str(raw.cwd) || (Array.isArray(raw.workspace_roots) && str(raw.workspace_roots[0])) || str(raw.workspaceRoot);
  if (cwd) out.cwd = cwd;
  if (str(raw.agent_id)) out.aid = raw.agent_id;
  if (str(raw.agent_type)) out.atype = raw.agent_type;
  if (str(raw.tool_use_id)) out.tuid = raw.tool_use_id;
  if (str(raw.model)) out.model = clip(raw.model, 60);
  return out;
}

// Map a tool to the Claude-style name + input the extension knows.
// `spec` = { read: [...names], edit: [...], write: [...], shell: [...], search: [...], web: [...], fetch: [...], task: [...] }
function mapTool(name, input, spec) {
  const lower = String(name || '').toLowerCase();
  const has = (k) => (spec[k] || []).includes(lower);
  const i = input && typeof input === 'object' ? input : {};
  const file = str(i.file_path) || str(i.absolute_path) || str(i.filePath) || str(i.path) || str(i.target_file) || str(i.notebook_path);
  if (has('read')) {
    const offset = num(i.offset) ?? num(i.start_line) ?? num(i.line);
    const limit = num(i.limit) ?? (num(i.end_line) && offset ? i.end_line - offset + 1 : undefined);
    return { tool: 'Read', input: { file_path: file, offset, limit } };
  }
  if (has('edit')) {
    const old_string = str(i.old_string) ?? str(i.oldString) ?? str(i.old_str) ?? str(i.search);
    const new_string = str(i.new_string) ?? str(i.newString) ?? str(i.new_str) ?? str(i.replace);
    const edits = Array.isArray(i.edits) ? i.edits.slice(0, 20).map((e) => ({ old_string: clip(e && (e.old_string ?? e.oldString)), new_string: clip(e && (e.new_string ?? e.newString)) })) : undefined;
    return { tool: edits ? 'MultiEdit' : 'Edit', input: { file_path: file, old_string: clip(old_string), new_string: clip(new_string), edits } };
  }
  if (has('write')) {
    const content = str(i.content) ?? str(i.contents) ?? str(i.text);
    return { tool: 'Write', input: { file_path: file, content_lines: content ? content.split('\n').length : undefined } };
  }
  if (has('shell')) {
    const command = str(i.command) ?? (Array.isArray(i.command) ? i.command.join(' ') : undefined) ?? str(i.cmd);
    const read = readFromShell(command);
    if (read) return { tool: 'Read', input: read, via: 'shell' };
    const search = searchFromShell(command);
    if (search) return { tool: 'Grep', input: search };
    return { tool: 'Bash', input: { command: clip(command, 300), description: clip(str(i.description), 120) } };
  }
  if (has('search')) return { tool: 'Grep', input: { pattern: clip(str(i.pattern) ?? str(i.query) ?? str(i.regex), 80), path: str(i.path) } };
  if (has('web')) return { tool: 'WebSearch', input: { query: clip(str(i.query), 120) } };
  if (has('fetch')) return { tool: 'WebFetch', input: { url: clip(str(i.url) ?? str(i.prompt), 200) } };
  if (has('task')) return { tool: 'Task', input: { description: clip(str(i.description) ?? str(i.prompt), 120), subagent_type: str(i.subagent_type) } };
  return { tool: String(name || 'tool'), input: {} };
}

function clean(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) if (v !== undefined) out[k] = v;
  return out;
}

function toolEvent(raw, agent, ev, name, input, spec, extra = {}) {
  const mapped = mapTool(name, input, spec);
  const out = base(raw, agent, ev);
  out.tool = mapped.tool;
  const i = clean(mapped.input);
  if (Object.keys(i).length) out.input = i;
  Object.assign(out, extra);
  return out;
}

// ---------- adapters ----------

const CLAUDE_TOOLS = {
  read: ['read'],
  edit: ['edit', 'multiedit', 'notebookedit'],
  write: ['write'],
  shell: [],
  search: ['grep', 'glob'],
  web: ['websearch'],
  fetch: ['webfetch'],
  task: ['task', 'agent'],
};

function claude(raw) {
  // Claude Code is the native shape; keep its exact tool names.
  const ev = raw.hook_event_name;
  const out = base(raw, 'claude', ev);
  if (raw.tool_name) out.tool = raw.tool_name;
  const i = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : undefined;
  if (i) {
    const input = clean({
      file_path: str(i.file_path),
      notebook_path: str(i.notebook_path),
      path: str(i.path),
      pattern: clip(str(i.pattern), 500),
      glob: str(i.glob),
      description: clip(str(i.description), 500),
      subagent_type: str(i.subagent_type),
      url: clip(str(i.url), 500),
      query: clip(str(i.query), 500),
      command: clip(str(i.command), 300),
      prompt: clip(str(i.prompt), 200),
      offset: num(i.offset),
      limit: num(i.limit),
      old_string: clip(i.old_string),
      new_string: clip(i.new_string),
      replace_all: typeof i.replace_all === 'boolean' ? i.replace_all : undefined,
      edits: Array.isArray(i.edits) ? i.edits.slice(0, 20).map((e) => ({ old_string: clip(e && e.old_string), new_string: clip(e && e.new_string) })) : undefined,
      content_lines: typeof i.content === 'string' ? i.content.split('\n').length : undefined,
    });
    if (Object.keys(input).length) out.input = input;
  }
  const patch = raw.tool_response && typeof raw.tool_response === 'object' ? raw.tool_response.structuredPatch : undefined;
  if (Array.isArray(patch)) {
    const hunks = patch.filter((h) => h && typeof h.newStart === 'number' && typeof h.newLines === 'number').slice(0, 50).map((h) => ({ newStart: h.newStart, newLines: h.newLines }));
    if (hunks.length) out.hunks = hunks;
  }
  if (ev === 'UserPromptSubmit' && typeof raw.prompt === 'string') out.prompt = clip(raw.prompt, 120);
  return ev ? [out] : [];
}

const CODEX_TOOLS = {
  read: ['read', 'read_file', 'view'],
  edit: ['edit'],
  write: ['write'],
  shell: ['bash', 'shell', 'exec_command', 'local_shell', 'unified_exec'],
  search: ['grep', 'glob', 'search'],
  web: ['websearch', 'web_search'],
  fetch: ['webfetch'],
  task: ['task', 'spawn_agent', 'agent'],
};

function codex(raw) {
  const ev = raw.hook_event_name;
  if (!ev) return [];
  const name = String(raw.tool_name || '');
  const isTool = ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PostToolUseFailure';
  if (isTool && /^(apply_patch|edit|write)$/i.test(name)) {
    const text = raw.tool_input && (raw.tool_input.command ?? raw.tool_input.patch ?? raw.tool_input.input);
    const files = parsePatch(Array.isArray(text) ? text.join('\n') : text);
    if (files.length) {
      return files.slice(0, 10).map((f, idx) => {
        const out = base(raw, 'codex', ev);
        if (out.tuid && files.length > 1) out.tuid = `${out.tuid}#${idx}`;
        if (f.op === 'add') {
          out.tool = 'Write';
          out.input = { file_path: f.file, content_lines: f.added.length || 1 };
        } else if (f.op === 'delete') {
          out.tool = 'Bash';
          out.input = { command: `delete ${f.file}`, description: `Delete ${path.basename(f.file)}` };
        } else {
          out.tool = f.hunks.length > 1 ? 'MultiEdit' : 'Edit';
          const edits = f.hunks.slice(0, 20).map((h) => ({ old_string: clip(h.old.join('\n')), new_string: clip(h.new.join('\n')) }));
          out.input = f.hunks.length > 1 ? { file_path: f.file, edits } : { file_path: f.file, ...edits[0] };
        }
        return out;
      });
    }
  }
  if (isTool) return [toolEvent(raw, 'codex', ev, name, raw.tool_input, CODEX_TOOLS)];
  const out = base(raw, 'codex', ev);
  if (ev === 'UserPromptSubmit' && typeof raw.prompt === 'string') out.prompt = clip(raw.prompt, 120);
  return [out];
}


// Gemini CLI: BeforeTool/AfterTool, Gemini tool names. We only register the
// After events (see settings), but map both in case.
const GEMINI_TOOLS = {
  read: ['read_file'],
  edit: ['replace', 'edit'],
  write: ['write_file'],
  shell: ['run_shell_command'],
  search: ['grep_search', 'search_file_content', 'glob', 'list_directory', 'read_many_files'],
  web: ['google_web_search', 'web_search'],
  fetch: ['web_fetch'],
  task: ['delegate_to_agent', 'subagent'],
};
const GEMINI_EVENTS = { BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop' };

function geminiLike(agent, tools, events) {
  return (raw) => {
    const ev = events[raw.hook_event_name] || raw.hook_event_name;
    if (!ev) return [];
    if (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PostToolUseFailure') {
      const failed = ev === 'PostToolUse' && raw.tool_response && raw.tool_response.error;
      return [toolEvent(raw, agent, failed ? 'PostToolUseFailure' : ev, raw.tool_name, raw.tool_input, tools)];
    }
    const out = base(raw, agent, ev);
    const prompt = str(raw.prompt) || str(raw.user_prompt);
    if (ev === 'UserPromptSubmit' && prompt) out.prompt = clip(prompt, 120);
    return [out];
  };
}

// Qwen Code: a Gemini CLI fork that uses Claude-style event names.
const QWEN_TOOLS = { ...GEMINI_TOOLS, edit: ['edit', 'replace'] };

// Kimi Code CLI: Claude-style events and tool names, `path` for files.
const KIMI_TOOLS = { read: ['read'], edit: ['edit', 'multiedit'], write: ['write'], shell: ['bash', 'shell'], search: ['grep', 'glob'], web: ['websearch', 'search_web'], fetch: ['fetch', 'fetchurl', 'fetch_url'], task: ['task', 'agent'] };

// Cursor: postToolUse (Shell/Read/Grep/Task...), afterFileEdit for edits.
const CURSOR_TOOLS = { read: ['read'], edit: ['edit', 'strreplace'], write: ['write'], shell: ['shell', 'terminal'], search: ['grep', 'glob', 'codebase_search'], web: ['websearch'], fetch: ['fetch'], task: ['task'] };
const CURSOR_EVENTS = { sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', stop: 'Stop', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure', beforeSubmitPrompt: 'UserPromptSubmit', subagentStart: 'SubagentStart', subagentStop: 'SubagentStop' };

function cursor(raw) {
  const name = raw.hook_event_name;
  if (name === 'afterFileEdit') {
    const file = str(raw.file_path);
    if (!file) return [];
    const edits = Array.isArray(raw.edits) ? raw.edits.slice(0, 20) : [];
    const out = base(raw, 'cursor', 'PostToolUse');
    out.tool = edits.length > 1 ? 'MultiEdit' : 'Edit';
    const e = edits.map((x) => ({ old_string: clip(x && x.old_string), new_string: clip(x && x.new_string) }));
    out.input = clean(edits.length > 1 ? { file_path: file, edits: e } : { file_path: file, ...(e[0] || {}) });
    return [out];
  }
  const ev = CURSOR_EVENTS[name];
  if (!ev) return [];
  if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') {
    if (/^(write|edit|strreplace)$/i.test(String(raw.tool_name || ''))) return []; // afterFileEdit covers these
    return [toolEvent(raw, 'cursor', ev, raw.tool_name, raw.tool_input, CURSOR_TOOLS)];
  }
  const out = base(raw, 'cursor', ev);
  if (ev === 'UserPromptSubmit' && str(raw.prompt)) out.prompt = clip(raw.prompt, 120);
  return [out];
}

// GitHub Copilot CLI: camelCase payloads (sessionId, toolName, toolArgs).
const COPILOT_TOOLS = { read: ['view', 'read'], edit: ['edit', 'str_replace', 'str_replace_editor'], write: ['create', 'write'], shell: ['bash', 'powershell', 'shell'], search: ['grep', 'rg', 'glob'], web: ['web_search'], fetch: ['web_fetch', 'fetch'], task: ['task'] };
const COPILOT_EVENTS = { sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', userPromptSubmitted: 'UserPromptSubmit', agentStop: 'Stop', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure', preToolUse: 'PreToolUse', subagentStop: 'SubagentStop' };

function copilot(raw) {
  const name = raw.hook_event_name || raw.hookEventName || raw.event;
  const ev = COPILOT_EVENTS[name] || (['PostToolUse', 'PreToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit'].includes(name) ? name : undefined);
  if (!ev) return [];
  const r = { ...raw, session_id: raw.session_id || raw.sessionId, tool_name: raw.tool_name || raw.toolName };
  let args = raw.tool_input || raw.toolArgs;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'PostToolUseFailure') {
    const toolName = String(r.tool_name || '');
    if (/^apply_patch$/i.test(toolName)) return codex({ ...r, hook_event_name: ev, tool_input: { command: args && (args.input || args.patch || args.command) } }).map((e) => ({ ...e, agent: 'copilot' }));
    if (/^str_replace_editor$/i.test(toolName) && args) {
      const sub = String(args.command || '');
      const kind = sub === 'view' ? 'view' : sub === 'create' ? 'create' : 'str_replace';
      return [toolEvent(r, 'copilot', ev, kind, { ...args, old_string: args.old_str, new_string: args.new_str, content: args.file_text }, COPILOT_TOOLS)];
    }
    const failed = ev === 'PostToolUse' && raw.toolResult && raw.toolResult.resultType === 'failure';
    return [toolEvent(r, 'copilot', failed ? 'PostToolUseFailure' : ev, toolName, args, COPILOT_TOOLS)];
  }
  const out = base(r, 'copilot', ev);
  if (ev === 'UserPromptSubmit' && str(raw.prompt)) out.prompt = clip(raw.prompt, 120);
  return [out];
}

// Windsurf (Cascade): post_read_code / post_write_code / post_run_command.
function windsurf(raw) {
  const action = raw.agent_action_name || raw.hook_event_name;
  const info = raw.tool_info && typeof raw.tool_info === 'object' ? raw.tool_info : {};
  const r = { ...raw, session_id: raw.trajectory_id || raw.session_id, cwd: raw.cwd || info.cwd };
  const out = base(r, 'windsurf', 'PostToolUse');
  if (action === 'post_read_code') {
    out.tool = 'Read';
    out.input = clean({ file_path: str(info.file_path) });
  } else if (action === 'post_write_code') {
    const edits = Array.isArray(info.edits) ? info.edits.slice(0, 20).map((e) => ({ old_string: clip(e && e.old_string), new_string: clip(e && e.new_string) })) : [];
    out.tool = edits.length > 1 ? 'MultiEdit' : 'Edit';
    out.input = clean(edits.length > 1 ? { file_path: str(info.file_path), edits } : { file_path: str(info.file_path), ...(edits[0] || {}) });
  } else if (action === 'post_run_command') {
    const command = str(info.command_line) || str(info.command);
    const read = readFromShell(command);
    out.tool = read ? 'Read' : 'Bash';
    out.input = clean(read || { command: clip(command, 300) });
  } else if (action === 'post_cascade_response' || action === 'post_response') {
    out.ev = 'Stop';
    delete out.tool;
  } else {
    return [];
  }
  if (out.input && !out.input.file_path && (out.tool === 'Read' || out.tool === 'Edit')) return [];
  return [out];
}

const ADAPTERS = {
  claude,
  codex,
  gemini: geminiLike('gemini', GEMINI_TOOLS, GEMINI_EVENTS),
  qwen: geminiLike('qwen', QWEN_TOOLS, {}),
  kimi: geminiLike('kimi', KIMI_TOOLS, {}),
  cursor,
  copilot,
  windsurf,
};


function adapt(agent, raw) {
  if (!raw || typeof raw !== 'object') return [];
  const fn = ADAPTERS[agent] || ADAPTERS.claude;
  try {
    return fn(raw).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { adapt, ADAPTERS, parsePatch, readFromShell, searchFromShell, mapTool, hunksFromUnifiedDiff, base, toolEvent, clip, str, num, clean };
