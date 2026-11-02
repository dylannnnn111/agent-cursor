#!/usr/bin/env node
// Agent Cursor hook for Claude Code.
// Reads one hook event from stdin, keeps only what the editor needs, and appends
// it as one line to ~/.agent-cursor/events.jsonl. It never prints anything and
// always exits 0, so it can't block or change what the agent does.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TEXT = 4000; // enough to find an edit in the file, small enough to keep the log light
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function logPath() {
  if (process.env.AGENT_CURSOR_LOG) return process.env.AGENT_CURSOR_LOG;
  return path.join(os.homedir(), '.agent-cursor', 'events.jsonl');
}

function clip(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

// Keep the fields we use from tool_input, under the names Claude Code uses today.
// Anything unknown is ignored rather than guessed at.
function pickInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  const str = ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'description', 'subagent_type', 'url', 'query'];
  for (const k of str) if (typeof input[k] === 'string') out[k] = clip(input[k], 500);
  if (typeof input.command === 'string') out.command = clip(input.command, 300);
  if (typeof input.prompt === 'string') out.prompt = clip(input.prompt, 200);
  for (const k of ['offset', 'limit']) if (typeof input[k] === 'number') out[k] = input[k];
  if (typeof input.old_string === 'string') out.old_string = clip(input.old_string);
  if (typeof input.new_string === 'string') out.new_string = clip(input.new_string);
  if (typeof input.replace_all === 'boolean') out.replace_all = input.replace_all;
  if (Array.isArray(input.edits)) {
    out.edits = input.edits.slice(0, 20).map((e) => ({
      old_string: clip(e && e.old_string),
      new_string: clip(e && e.new_string),
    }));
  }
  if (typeof input.content === 'string') out.content_lines = input.content.split('\n').length;
  return out;
}

// Line numbers from the tool result, when Claude Code gives a patch. Optional:
// the extension finds the edit in the file itself if this isn't there.
function pickHunks(response) {
  const patch = response && typeof response === 'object' ? response.structuredPatch : undefined;
  if (!Array.isArray(patch)) return undefined;
  const hunks = patch
    .filter((h) => h && typeof h.newStart === 'number' && typeof h.newLines === 'number')
    .slice(0, 50)
    .map((h) => ({ newStart: h.newStart, newLines: h.newLines }));
  return hunks.length ? hunks : undefined;
}

function compact(raw) {
  const ev = {
    t: Date.now(),
    ev: raw.hook_event_name,
    sid: raw.session_id,
    cwd: raw.cwd,
  };
  if (raw.agent_id) ev.aid = raw.agent_id;
  if (raw.agent_type) ev.atype = raw.agent_type;
  if (raw.tool_name) ev.tool = raw.tool_name;
  if (raw.tool_use_id) ev.tuid = raw.tool_use_id;
  const input = pickInput(raw.tool_input);
  if (input && Object.keys(input).length) ev.input = input;
  const hunks = pickHunks(raw.tool_response);
  if (hunks) ev.hunks = hunks;
  if (raw.hook_event_name === 'UserPromptSubmit' && typeof raw.prompt === 'string') {
    ev.prompt = clip(raw.prompt, 120);
  }
  return ev;
}

function append(line) {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.old');
  } catch {
    // no log yet
  }
  fs.appendFileSync(file, line + '\n');
}

function main() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (raw && typeof raw === 'object' && raw.hook_event_name) append(JSON.stringify(compact(raw)));
    } catch {
      // never get in the agent's way
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

if (require.main === module) main();
module.exports = { compact, pickInput, pickHunks };
