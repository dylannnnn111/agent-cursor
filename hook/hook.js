#!/usr/bin/env node
// Agent Cursor hook. Coding agents run this on their hook events:
//   node hook.js --agent claude|codex|gemini|qwen|cursor|copilot|kimi|cline
// It reads one event from stdin, keeps only what the editor needs (see
// adapters.js), and appends it to ~/.agent-cursor/events.jsonl.
// It never blocks or changes what the agent does: it always exits 0 and only
// prints the neutral reply an agent requires (most need nothing at all).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { adapt } = require('./adapters');

const MAX_LOG_BYTES = 2 * 1024 * 1024;

// What each agent needs on stdout for "carry on as normal". Empty = print nothing.
// Gemini CLI and Cursor parse stdout as JSON, so they get an empty object (no decision).
const NEUTRAL_REPLY = { gemini: '{}', cursor: '{}' };

function logPath() {
  if (process.env.AGENT_CURSOR_LOG) return process.env.AGENT_CURSOR_LOG;
  return path.join(os.homedir(), '.agent-cursor', 'events.jsonl');
}

function agentArg(argv) {
  const i = argv.indexOf('--agent');
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && /^[a-z0-9-]+$/.test(v) ? v : 'claude';
}

function append(lines) {
  if (!lines.length) return;
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.old');
  } catch {
    // no log yet
  }
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function reply(agent, raw) {
  const r = NEUTRAL_REPLY[agent];
  const out = typeof r === 'function' ? r(raw) : r;
  if (out) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
}

function main() {
  const agent = agentArg(process.argv);
  const chunks = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let raw;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      append(adapt(agent, raw));
    } catch {
      // never get in the agent's way
    }
    try {
      reply(agent, raw);
    } catch {
      // ditto
    }
    process.exit(0);
  };
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 3000); // some agents keep stdin open
}

if (require.main === module) main();

// Kept for the tests: the Claude adapter used to live here.
const compact = (raw) => adapt('claude', raw)[0];
module.exports = { compact, agentArg, NEUTRAL_REPLY };
