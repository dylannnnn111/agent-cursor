import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SETUPS, addTomlBlocks, removeTomlBlocks, hasTomlBlocks } from '../core/agents';
import { addHooks, hasHooks, removeHooks } from '../core/settings';
import { KINDS } from '../core/kinds';

const CMD = '/usr/local/bin/node /Users/d/.agent-cursor/hook.js --agent X';

test('every connectable agent has a look and a working config round trip', () => {
  for (const s of SETUPS) {
    assert.ok(KINDS[s.id], `${s.id} has a kind`);
    if (!s.spec) continue;
    const mine = { theirs: true, hooks: { [s.spec.events[0]]: [{ command: 'their-own.sh', hooks: [{ type: 'command', command: 'their-own.sh' }] }] } };
    const on = addHooks(mine, CMD.replace('X', s.id), s.spec);
    assert.equal(hasHooks(on), true, s.id);
    assert.deepEqual(addHooks(on, CMD.replace('X', s.id), s.spec), on, `${s.id} adds once`);
    const off = removeHooks(on);
    assert.deepEqual(off.hooks, mine.hooks, `${s.id} removes cleanly`);
    assert.equal(off.theirs, true);
    for (const e of s.spec.events) assert.ok(on.hooks[e], `${s.id} ${e}`);
  }
});

test('agents whose before-hooks expect an answer only get after-hooks', () => {
  for (const id of ['cursor', 'copilot', 'gemini']) {
    const s = SETUPS.find((x) => x.id === id)!;
    for (const e of s.spec!.events) assert.doesNotMatch(e, /^(pre|before)(ToolUse|Tool|Shell|ReadFile|MCP)/i, `${id}: ${e}`);
  }
});

test('Cursor and Copilot files get version 1, flat shape', () => {
  const cursor = addHooks({}, CMD, SETUPS.find((x) => x.id === 'cursor')!.spec);
  assert.equal(cursor.version, 1);
  assert.equal(cursor.hooks.afterFileEdit[0].command, CMD);
  const cop = addHooks({}, CMD, SETUPS.find((x) => x.id === 'copilot')!.spec);
  assert.equal(cop.hooks.postToolUse[0].bash, CMD);
  assert.equal(cop.hooks.postToolUse[0].type, 'command');
});

test('Kimi TOML: blocks added between markers and removed cleanly', () => {
  const before = 'default_model = "kimi-k2"\n\n[[hooks]]\nevent = "Stop"\ncommand = "notify.sh"\n';
  const on = addTomlBlocks(before, CMD, ['PreToolUse', 'PostToolUse']);
  assert.equal(hasTomlBlocks(on), true);
  assert.equal((on.match(/\[\[hooks\]\]/g) || []).length, 3);
  assert.equal(addTomlBlocks(on, CMD, ['PreToolUse', 'PostToolUse']), on);
  assert.equal(removeTomlBlocks(on).trim(), before.trim());
});

test('hook script: Gemini and Cursor get "{}" on stdout, others nothing, always exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  const log = path.join(dir, 'e.jsonl');
  const hook = path.join(__dirname, '..', '..', 'hook', 'hook.js');
  const run = (agent: string, payload: string) => execFileSync('node', [hook, '--agent', agent], { input: payload, env: { ...process.env, AGENT_CURSOR_LOG: log } }).toString();
  assert.equal(run('gemini', JSON.stringify({ hook_event_name: 'AfterTool', session_id: 's', tool_name: 'read_file', tool_input: { file_path: '/a.py' } })), '{}');
  assert.equal(run('cursor', JSON.stringify({ hook_event_name: 'stop', conversation_id: 'c' })), '{}');
  assert.equal(run('claude', JSON.stringify({ hook_event_name: 'Stop', session_id: 's' })), '');
  assert.equal(run('codex', 'garbage'), '');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.agent), ['gemini', 'cursor', 'claude']);
});
