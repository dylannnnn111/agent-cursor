// A scripted session over the files in this workspace, so people can see what
// Agent Cursor does before connecting Claude Code. Nothing is changed on disk.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEMO_SID, HookEvent } from './core/state';

const CODE = /\.(py|ts|tsx|js|jsx|go|rs|java|rb|php|cs|cpp|c|h|swift|kt|md)$/i;

function lineCount(file: string): number {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').length;
  } catch {
    return 1;
  }
}

export async function pickDemoFiles(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/dist/**,**/out/**}', 400);
  const files = uris.map((u) => u.fsPath).filter((f) => CODE.test(f));
  const open = vscode.window.activeTextEditor?.document.uri.fsPath;
  const list = [...new Set([...(open && CODE.test(open) ? [open] : []), ...files.sort()])];
  return list.slice(0, 6);
}

export function demoScript(files: string[], cwd: string, start: number): HookEvent[] {
  const sid = DEMO_SID;
  const at = (s: number) => start + Math.round(s * 1000);
  const f = (i: number) => files[i % files.length];
  const n = (i: number) => lineCount(f(i));
  const mid = (i: number, frac: number) => Math.max(1, Math.min(n(i), Math.round(n(i) * frac)));
  const ev = (s: number, e: Partial<HookEvent>): HookEvent => ({ t: at(s), sid, cwd, ev: 'PreToolUse', ...e }) as HookEvent;
  const rel = (i: number) => path.basename(f(i));

  const out: HookEvent[] = [
    ev(0, { ev: 'SessionStart' }),
    ev(0.4, { ev: 'UserPromptSubmit', prompt: `Tidy up ${rel(1)} and add a test for it` }),
    ev(1.6, { tool: 'Glob', tuid: 'd1', input: { pattern: '**/*' } }),
    ev(2.2, { ev: 'PostToolUse', tool: 'Glob', tuid: 'd1' }),
    ev(2.6, { tool: 'Read', tuid: 'd2', input: { file_path: f(0) } }),
    ev(3.8, { ev: 'PostToolUse', tool: 'Read', tuid: 'd2', input: { file_path: f(0) } }),
    ev(4.2, { tool: 'Read', tuid: 'd3', input: { file_path: f(1) } }),
    ev(5.6, { ev: 'PostToolUse', tool: 'Read', tuid: 'd3', input: { file_path: f(1) } }),
    ev(6.0, { tool: 'Grep', tuid: 'd4', input: { pattern: 'def |function ' } }),
    ev(6.8, { ev: 'PostToolUse', tool: 'Grep', tuid: 'd4' }),
    ev(7.2, { ev: 'SessionStart', sid: `${DEMO_SID}-codex`, agent: 'codex' }),
  ];
  // a Codex session wanders through other files while Claude edits
  const sub = (s: number, e: Partial<HookEvent>) => ev(s, { sid: `${DEMO_SID}-codex`, agent: 'codex', ...e });
  out.push(
    sub(7.8, { tool: 'Read', tuid: 's1', input: { file_path: f(2) } }),
    sub(9.4, { ev: 'PostToolUse', tool: 'Read', tuid: 's1', input: { file_path: f(2) } }),
    sub(9.8, { tool: 'Read', tuid: 's2', input: { file_path: f(3), offset: 1, limit: 30 } }),
    sub(11.2, { ev: 'PostToolUse', tool: 'Read', tuid: 's2', input: { file_path: f(3) } }),
    sub(11.6, { tool: 'Read', tuid: 's3', input: { file_path: f(4) } }),
    sub(13.0, { ev: 'PostToolUse', tool: 'Read', tuid: 's3', input: { file_path: f(4) } }),
    sub(13.4, { tool: 'Edit', tuid: 's4', input: { file_path: f(3) } }),
    sub(14.4, { ev: 'PostToolUse', tool: 'Edit', tuid: 's4', input: { file_path: f(3) }, hunks: [{ newStart: mid(3, 0.4), newLines: 3 }] }),
    sub(15.0, { ev: 'Stop' }),
  );
  // and a Gemini session reads and runs the tests
  const gem = (s: number, e: Partial<HookEvent>) => ev(s, { sid: `${DEMO_SID}-gemini`, agent: 'gemini', ...e });
  out.push(
    gem(3.0, { ev: 'SessionStart' }),
    gem(3.4, { tool: 'Read', tuid: 'g1', input: { file_path: f(4) } }),
    gem(5.2, { ev: 'PostToolUse', tool: 'Read', tuid: 'g1', input: { file_path: f(4) } }),
    gem(5.6, { tool: 'Read', tuid: 'g2', input: { file_path: f(5) } }),
    gem(8.0, { ev: 'PostToolUse', tool: 'Read', tuid: 'g2', input: { file_path: f(5) } }),
    gem(8.4, { tool: 'Edit', tuid: 'g3', input: { file_path: f(5) } }),
    gem(9.6, { ev: 'PostToolUse', tool: 'Edit', tuid: 'g3', input: { file_path: f(5) }, hunks: [{ newStart: mid(5, 0.6), newLines: 4 }] }),
    gem(10.2, { tool: 'Bash', tuid: 'g4', input: { command: 'pytest -q' } }),
    gem(13.0, { ev: 'PostToolUse', tool: 'Bash', tuid: 'g4' }),
    gem(16.5, { tool: 'Read', tuid: 'g5', input: { file_path: f(2) } }),
    gem(18.5, { ev: 'PostToolUse', tool: 'Read', tuid: 'g5', input: { file_path: f(2) } }),
    gem(19.5, { ev: 'Stop' }),
  );
  const l1 = mid(1, 0.3);
  const l2 = mid(1, 0.65);
  out.push(
    ev(8.2, { tool: 'Edit', tuid: 'd6', input: { file_path: f(1) } }),
    ev(9.2, { ev: 'PostToolUse', tool: 'Edit', tuid: 'd6', input: { file_path: f(1) }, hunks: [{ newStart: l1, newLines: 4 }] }),
    ev(9.8, { tool: 'Edit', tuid: 'd7', input: { file_path: f(1) } }),
    ev(10.9, { ev: 'PostToolUse', tool: 'Edit', tuid: 'd7', input: { file_path: f(1) }, hunks: [{ newStart: l2, newLines: 6 }] }),
    ev(14.0, { tool: 'Edit', tuid: 'd8', input: { file_path: f(0) } }),
    ev(15.0, { ev: 'PostToolUse', tool: 'Edit', tuid: 'd8', input: { file_path: f(0) }, hunks: [{ newStart: mid(0, 0.5), newLines: 3 }] }),
    ev(15.6, { tool: 'Bash', tuid: 'd9', input: { command: 'npm test', description: 'run the tests' } }),
    ev(18.0, { ev: 'PostToolUse', tool: 'Bash', tuid: 'd9' }),
    ev(18.4, { tool: 'Read', tuid: 'd10', input: { file_path: f(1), offset: l1, limit: 12 } }),
    ev(19.4, { ev: 'PostToolUse', tool: 'Read', tuid: 'd10', input: { file_path: f(1) } }),
    ev(20.0, { ev: 'Stop' }),
  );
  return out.sort((a, b) => a.t - b.t);
}
