import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { locate, countLines } from '../core/locate';
import { apply, createModel, tick, HookEvent, FADE_MS, IDLE_MS, SUBAGENT_LINGER_MS, snapshot } from '../core/state';
import { addHooks, removeHooks, hasHooks, hookCommand, HOOK_EVENTS } from '../core/settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hook = require(path.join(__dirname, '..', '..', 'hook', 'hook.js'));

const FILE = '/proj/app.py';
const TEXT = ['import os', '', 'def add(a, b):', '    return a + b', '', 'def sub(a, b):', '    return a - b', ''].join('\n');
const files: Record<string, string> = { [FILE]: TEXT };
const read = (f: string) => files[f];
let t = 1000;
const ev = (e: Partial<HookEvent>): HookEvent => ({ t: (t += 10), sid: 's1', cwd: '/proj', ev: 'PreToolUse', ...e }) as HookEvent;

test('locate finds a snippet as 0-based lines', () => {
  assert.deepEqual(locate(TEXT, 'def sub(a, b):\n    return a - b'), { start: 5, end: 6 });
  assert.deepEqual(locate(TEXT, 'def add(a, b):\n'), { start: 2, end: 2 });
  assert.equal(locate(TEXT, 'nothing like this'), undefined);
  // a clipped snippet still lands on its first line
  assert.deepEqual(locate(TEXT, '    return a - b\n    # clipped tail that is not in the file'), { start: 6, end: 6 });
  assert.equal(countLines('a\nb'), 2);
});

test('Read puts the agent on the first line it reads', () => {
  const m = createModel();
  apply(m, ev({ tool: 'Read', tuid: 'r1', input: { file_path: FILE, offset: 3, limit: 2 } }), read);
  const a = m.agents.get('s1')!;
  assert.equal(a.activity, 'reading');
  assert.equal(a.file, FILE);
  assert.equal(a.line, 2);
  assert.equal(a.endLine, 3);
  assert.equal(m.touched.get(FILE)?.read, true);
  assert.match(m.feed[0].text, /Reading app\.py \(lines 3-4\)/);
});

test('relative paths resolve against cwd', () => {
  const m = createModel();
  apply(m, ev({ tool: 'Read', input: { file_path: 'app.py' } }), read);
  assert.equal(m.agents.get('s1')!.file, FILE);
});

test('Edit: located before, highlighted after, then back to thinking', () => {
  const m = createModel();
  apply(m, ev({ tool: 'Edit', tuid: 'e1', input: { file_path: FILE, old_string: '    return a - b', new_string: '    return a - b  # x' } }), read);
  const a = m.agents.get('s1')!;
  assert.equal(a.activity, 'editing');
  assert.equal(a.line, 6);
  files[FILE] = TEXT.replace('    return a - b', '    return a - b  # x');
  apply(m, ev({ ev: 'PostToolUse', tool: 'Edit', tuid: 'e1', input: { file_path: FILE, old_string: '    return a - b', new_string: '    return a - b  # x' } }), read);
  assert.equal(a.activity, 'thinking');
  assert.equal(m.changes.length, 1);
  assert.deepEqual([m.changes[0].start, m.changes[0].end], [6, 6]);
  assert.equal(m.touched.get(FILE)?.edited, true);
  assert.equal(m.pending.size, 0);
  files[FILE] = TEXT;
});

test('a deletion falls back to where the edit was found', () => {
  const m = createModel();
  apply(m, ev({ tool: 'Edit', tuid: 'e2', input: { file_path: FILE, old_string: 'import os\n', new_string: '' } }), read);
  apply(m, ev({ ev: 'PostToolUse', tool: 'Edit', tuid: 'e2', input: { file_path: FILE, old_string: 'import os\n', new_string: '' } }), read);
  assert.deepEqual([m.changes[0].start, m.changes[0].end], [0, 0]);
});

test('patch hunks from Claude Code win over searching', () => {
  const m = createModel();
  apply(m, ev({ ev: 'PostToolUse', tool: 'Edit', input: { file_path: FILE }, hunks: [{ newStart: 3, newLines: 2 }, { newStart: 6, newLines: 0 }] }), read);
  assert.deepEqual(m.changes.map((c) => [c.start, c.end]), [[2, 3], [5, 5]]);
  assert.match(m.feed[0].text, /2 places/);
});

test('subagents get their own colour and go away after they finish', () => {
  const m = createModel();
  apply(m, ev({ ev: 'UserPromptSubmit', prompt: 'do things' }), read);
  apply(m, ev({ ev: 'SubagentStart', aid: 'a1', atype: 'Explore' }), read);
  apply(m, ev({ aid: 'a1', atype: 'Explore', tool: 'Grep', input: { pattern: 'def ' } }), read);
  const sub = m.agents.get('s1:a1')!;
  assert.equal(sub.label, 'Claude › Explore');
  assert.notEqual(sub.colorIndex, m.agents.get('s1')!.colorIndex);
  assert.equal(sub.activity, 'searching');
  apply(m, ev({ ev: 'SubagentStop', aid: 'a1' }), read);
  assert.equal(tick(m, t + SUBAGENT_LINGER_MS + 1), true);
  assert.equal(m.agents.has('s1:a1'), false);
  assert.equal(m.agents.has('s1'), true);
});

test('two sessions are told apart', () => {
  const m = createModel();
  apply(m, ev({ ev: 'SessionStart' }), read);
  apply(m, ev({ sid: 's2', ev: 'SessionStart' }), read);
  const labels = [...m.agents.values()].map((a) => a.label);
  assert.deepEqual(labels, ['Claude', 'Claude 2']);
});

test('glow fades, quiet agents go idle, SessionEnd removes them', () => {
  const m = createModel();
  apply(m, ev({ ev: 'PostToolUse', tool: 'Write', input: { file_path: FILE, content_lines: 8 } }), read);
  assert.deepEqual([m.changes[0].start, m.changes[0].end], [0, 7]);
  apply(m, ev({ tool: 'Bash', input: { command: 'pytest -q' } }), read);
  assert.equal(m.agents.get('s1')!.activity, 'running');
  tick(m, t + Math.max(FADE_MS, IDLE_MS) + 1);
  assert.equal(m.changes.length, 0);
  assert.equal(m.agents.get('s1')!.activity, 'idle');
  apply(m, ev({ ev: 'SessionEnd' }), read);
  assert.equal(m.agents.size, 0);
});

test('unknown tools and junk events are handled', () => {
  const m = createModel();
  apply(m, ev({ tool: 'mcp__github__create_issue' }), read);
  assert.equal(m.agents.get('s1')!.detail, 'Using github › create_issue');
  assert.equal(apply(m, {} as HookEvent, read), false);
  assert.equal(apply(m, ev({ ev: 'Notification' }), read), false);
  const snap = snapshot(m, t);
  assert.equal(snap.agents.length, 1);
});

test('hooks are added once, alongside the person’s own, and removed cleanly', () => {
  const mine = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check.sh' }] }] } };
  const cmd = hookCommand('/usr/local/bin/node', '/Users/d/.agent-cursor/hook.js');
  const once = addHooks(mine, cmd);
  const twice = addHooks(once, cmd);
  assert.deepEqual(twice, once);
  assert.equal(hasHooks(once), true);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.equal(once.hooks.PreToolUse[1].matcher, '*');
  assert.equal(once.hooks.PreToolUse[1].hooks[0].async, true);
  assert.equal(once.hooks.Stop[0].matcher, undefined);
  assert.equal(Object.keys(once.hooks).length, HOOK_EVENTS.length);
  assert.deepEqual(removeHooks(once), mine);
  assert.deepEqual(removeHooks({ model: 'x' }), { model: 'x' });
});

test('hook commands quote paths with spaces', () => {
  assert.equal(hookCommand('/usr/bin/node', '/a/b.js'), '/usr/bin/node /a/b.js');
  assert.equal(hookCommand('/Applications/Code Helper', '/a/b.js'), '"/Applications/Code Helper" /a/b.js');
});

test('hook script keeps what the editor needs and drops the rest', () => {
  const big = 'x'.repeat(10_000);
  const out = hook.compact({
    hook_event_name: 'PostToolUse',
    session_id: 's',
    cwd: '/p',
    tool_name: 'Write',
    tool_use_id: 'u',
    agent_id: 'a',
    agent_type: 'Explore',
    transcript_path: '/secret/path',
    tool_input: { file_path: '/p/f.py', content: 'a\nb\nc', old_string: big },
    tool_response: { structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a'] }], content: big },
  });
  assert.equal(out.tool, 'Write');
  assert.equal(out.aid, 'a');
  assert.equal(out.input.content_lines, 3);
  assert.equal(out.input.content, undefined);
  assert.equal(out.input.old_string.length, 4000);
  assert.deepEqual(out.hunks, [{ newStart: 1, newLines: 3 }]);
  assert.equal(JSON.stringify(out).includes('secret'), false);
});
