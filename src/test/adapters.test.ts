import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { apply, createModel, HookEvent } from '../core/state';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const A = require(path.join(__dirname, '..', '..', 'hook', 'adapters.js'));

const FILE = '/proj/1.py';
const TEXT = ['def add_item(cart, name, price, qty=1):', '    cart.append({"name": name})', '    return cart', ''].join('\n');
const read = (f: string) => (f === FILE ? TEXT : undefined);

test('Codex apply_patch becomes one Edit per file, plus a Write for new files', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: 1.py',
    '@@ def add_item(cart, name, price, qty=1):',
    '-    cart.append({"name": name})',
    '+    cart.append({"name": name, "qty": qty})',
    '     return cart',
    '*** Add File: tests/test_1.py',
    '+import pytest',
    '+',
    '+def test_add(): pass',
    '*** End Patch',
  ].join('\n');
  const evs = A.adapt('codex', { hook_event_name: 'PreToolUse', session_id: 'c1', cwd: '/proj', tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: { command: patch } });
  assert.equal(evs.length, 2);
  assert.equal(evs[0].agent, 'codex');
  assert.equal(evs[0].tool, 'Edit');
  assert.equal(evs[0].input.file_path, '1.py');
  assert.match(evs[0].input.new_string, /"qty": qty/);
  assert.equal(evs[1].tool, 'Write');
  assert.equal(evs[1].input.content_lines, 3);

  // and the model places it on the right line, in Codex's colours
  const m = createModel();
  apply(m, evs[0] as HookEvent, read);
  const a = m.agents.get('c1')!;
  assert.equal(a.kind, 'codex');
  assert.equal(a.label, 'Codex');
  assert.equal(a.line, 1);
});

test('shell reads show up as reads, other commands as commands', () => {
  assert.deepEqual(A.readFromShell("sed -n '10,40p' src/a.py"), { file_path: 'src/a.py', offset: 10, limit: 31 });
  assert.deepEqual(A.readFromShell('bash -lc "nl -ba 2.py | head -50"'), { file_path: '2.py', offset: 1, limit: 50 });
  assert.deepEqual(A.readFromShell('cat 1.py'), { file_path: '1.py' });
  assert.equal(A.readFromShell('cat a.py | grep x'), undefined);
  assert.equal(A.readFromShell('rm -rf build'), undefined);
  const [ev] = A.adapt('codex', { hook_event_name: 'PreToolUse', session_id: 'c', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'cat 1.py' } });
  assert.equal(ev.tool, 'Read');
  const [run] = A.adapt('codex', { hook_event_name: 'PreToolUse', session_id: 'c', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'pytest -q' } });
  assert.equal(run.tool, 'Bash');
});

test('each agent type numbers its own sessions and keeps its own colours', () => {
  const m = createModel();
  let t = 1;
  const ev = (sid: string, agent?: string) => ({ t: t++, sid, agent, ev: 'SessionStart' }) as HookEvent;
  apply(m, ev('a', 'claude'), read);
  apply(m, ev('b', 'codex'), read);
  apply(m, ev('c', 'codex'), read);
  apply(m, ev('d'), read); // old events without an agent are Claude
  const by = Object.fromEntries([...m.agents.values()].map((x) => [x.sid, x]));
  assert.deepEqual([by.a.label, by.b.label, by.c.label, by.d.label], ['Claude', 'Codex', 'Codex 2', 'Claude 2']);
  assert.notEqual(by.b.color, by.c.color);
  assert.equal(by.b.kind, 'codex');
});

test('junk never throws', () => {
  for (const agent of Object.keys(A.ADAPTERS)) {
    assert.deepEqual(A.adapt(agent, null), []);
    assert.ok(Array.isArray(A.adapt(agent, { nonsense: true })));
    assert.ok(Array.isArray(A.adapt(agent, { hook_event_name: 'PreToolUse', tool_input: 'not an object' })));
  }
});

test('Gemini CLI: AfterTool with Gemini tool names', () => {
  const [ev] = A.adapt('gemini', { hook_event_name: 'AfterTool', session_id: 'g', cwd: '/proj', tool_name: 'replace', tool_input: { file_path: '/proj/1.py', old_string: 'a', new_string: 'b' }, tool_response: {} });
  assert.deepEqual([ev.agent, ev.ev, ev.tool, ev.input.file_path, ev.input.new_string], ['gemini', 'PostToolUse', 'Edit', '/proj/1.py', 'b']);
  const [r] = A.adapt('gemini', { hook_event_name: 'AfterTool', session_id: 'g', tool_name: 'read_file', tool_input: { file_path: 'x.py', start_line: 5, end_line: 9 } });
  assert.deepEqual([r.tool, r.input.offset, r.input.limit], ['Read', 5, 5]);
  const [f] = A.adapt('gemini', { hook_event_name: 'AfterTool', session_id: 'g', tool_name: 'run_shell_command', tool_input: { command: 'ls' }, tool_response: { error: 'boom' } });
  assert.equal(f.ev, 'PostToolUseFailure');
  assert.equal(A.adapt('gemini', { hook_event_name: 'AfterAgent', session_id: 'g' })[0].ev, 'Stop');
});

test('Cursor: afterFileEdit carries the edit; postToolUse skips edits it covers', () => {
  const [e] = A.adapt('cursor', { hook_event_name: 'afterFileEdit', conversation_id: 'cv', workspace_roots: ['/proj'], file_path: '/proj/2.py', edits: [{ old_string: 'x', new_string: 'y' }] });
  assert.deepEqual([e.agent, e.sid, e.cwd, e.tool, e.input.file_path], ['cursor', 'cv', '/proj', 'Edit', '/proj/2.py']);
  assert.deepEqual(A.adapt('cursor', { hook_event_name: 'postToolUse', conversation_id: 'cv', tool_name: 'Write', tool_input: { file_path: '/proj/2.py' } }), []);
  const [sh] = A.adapt('cursor', { hook_event_name: 'postToolUse', conversation_id: 'cv', tool_name: 'Shell', tool_input: { command: 'npm test' } });
  assert.equal(sh.tool, 'Bash');
});

test('Copilot CLI: camelCase payload, str_replace_editor and apply_patch', () => {
  const [v] = A.adapt('copilot', { hook_event_name: 'postToolUse', sessionId: 'cp', cwd: '/proj', toolName: 'view', toolArgs: JSON.stringify({ path: '/proj/3.py' }) });
  assert.deepEqual([v.agent, v.sid, v.tool, v.input.file_path], ['copilot', 'cp', 'Read', '/proj/3.py']);
  const [s] = A.adapt('copilot', { hook_event_name: 'postToolUse', sessionId: 'cp', toolName: 'str_replace_editor', toolArgs: { command: 'str_replace', path: '/proj/3.py', old_str: 'a', new_str: 'b' } });
  assert.deepEqual([s.tool, s.input.old_string, s.input.new_string], ['Edit', 'a', 'b']);
  const p = A.adapt('copilot', { hook_event_name: 'postToolUse', sessionId: 'cp', toolName: 'apply_patch', toolArgs: { input: '*** Begin Patch\n*** Update File: 4.py\n@@\n-a\n+b\n*** End Patch' } });
  assert.deepEqual([p[0].agent, p[0].tool, p[0].input.file_path], ['copilot', 'Edit', '4.py']);
});

test('Kimi Code, Qwen Code and Windsurf map to the same shape', () => {
  const [k] = A.adapt('kimi', { hook_event_name: 'PostToolUse', session_id: 'k', cwd: '/p', tool_name: 'Edit', tool_input: { path: 'a.py', old_string: 'x', new_string: 'y' } });
  assert.deepEqual([k.agent, k.tool, k.input.file_path], ['kimi', 'Edit', 'a.py']);
  const [q] = A.adapt('qwen', { hook_event_name: 'PreToolUse', session_id: 'q', cwd: '/p', tool_name: 'read_file', tool_input: { file_path: '/p/b.py' } });
  assert.deepEqual([q.agent, q.ev, q.tool], ['qwen', 'PreToolUse', 'Read']);
  const [w] = A.adapt('windsurf', { agent_action_name: 'post_write_code', trajectory_id: 'w', tool_info: { file_path: '/p/c.py', edits: [{ old_string: 'm', new_string: 'n' }] } });
  assert.deepEqual([w.agent, w.sid, w.tool, w.input.new_string], ['windsurf', 'w', 'Edit', 'n']);
});
