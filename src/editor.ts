// Draws the agents in the editor: a marker on the line each agent is on,
// a soft band over what it's reading, and a glow on lines it just changed
// that fades out over a few seconds.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { colorOf, PALETTE, rgba } from './colors';
import { FADE_MS, Model, isBusy } from './core/state';

const GLOW_LEVELS = [0.34, 0.24, 0.15, 0.07];

const VERB: Record<string, string> = {
  reading: 'reading',
  editing: 'editing',
  writing: 'writing',
  searching: 'searching',
  running: 'running a command',
  browsing: 'on the web',
  delegating: 'handing off',
  working: 'working',
  thinking: 'thinking',
  idle: 'was here',
};

interface ColorTypes {
  markerStrong: vscode.TextEditorDecorationType;
  markerSoft: vscode.TextEditorDecorationType;
  markerIdle: vscode.TextEditorDecorationType;
  band: vscode.TextEditorDecorationType;
  glow: vscode.TextEditorDecorationType[];
}

function writeIcons(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  return PALETTE.map((c, i) => {
    const file = path.join(dir, `agent-${i}.svg`);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
      `<circle cx="8" cy="8" r="6.5" fill="${c}" fill-opacity="0.25"/>` +
      `<circle cx="8" cy="8" r="4" fill="${c}"/>` +
      `<path d="M8 5.6 8.7 7.3 10.4 8 8.7 8.7 8 10.4 7.3 8.7 5.6 8 7.3 7.3Z" fill="#fff"/></svg>`;
    fs.writeFileSync(file, svg);
    return file;
  });
}

export class EditorView implements vscode.Disposable {
  private types: ColorTypes[];
  private phase = false;

  constructor(storageDir: string) {
    const icons = writeIcons(path.join(storageDir, 'icons'));
    this.types = PALETTE.map((c, i) => {
      const marker = (bg: number, border: number): vscode.DecorationRenderOptions => ({
        isWholeLine: true,
        backgroundColor: rgba(c, bg),
        borderColor: rgba(c, border),
        borderStyle: 'solid',
        borderWidth: '0 0 0 3px',
        gutterIconPath: vscode.Uri.file(icons[i]),
        gutterIconSize: '80%',
        overviewRulerColor: c,
        overviewRulerLane: vscode.OverviewRulerLane.Full,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      return {
        markerStrong: vscode.window.createTextEditorDecorationType(marker(0.2, 1)),
        markerSoft: vscode.window.createTextEditorDecorationType(marker(0.1, 0.55)),
        markerIdle: vscode.window.createTextEditorDecorationType({
          ...marker(0.05, 0.35),
          overviewRulerColor: rgba(c, 0.4),
        }),
        band: vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: rgba(c, 0.05),
          borderColor: rgba(c, 0.3),
          borderStyle: 'dotted',
          borderWidth: '0 0 0 2px',
        }),
        glow: GLOW_LEVELS.map((a) =>
          vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: rgba(c, a),
            overviewRulerColor: rgba(c, Math.min(1, a * 2.5)),
            overviewRulerLane: vscode.OverviewRulerLane.Left,
          }),
        ),
      };
    });
  }

  render(model: Model, now: number) {
    this.phase = !this.phase;
    for (const editor of vscode.window.visibleTextEditors) this.renderEditor(editor, model, now);
  }

  private renderEditor(editor: vscode.TextEditor, model: Model, now: number) {
    const file = editor.document.uri.fsPath;
    const last = editor.document.lineCount - 1;
    const clamp = (l: number) => Math.max(0, Math.min(l, last));
    const per = this.types.map(() => ({
      strong: [] as vscode.DecorationOptions[],
      soft: [] as vscode.DecorationOptions[],
      idle: [] as vscode.DecorationOptions[],
      band: [] as vscode.Range[],
      glow: GLOW_LEVELS.map(() => [] as vscode.Range[]),
    }));

    const here = [...model.agents.values()].filter((a) => a.file === file && a.line !== undefined);
    const stacked = new Map<number, number>();
    for (const a of here) {
      const slot = per[a.colorIndex % per.length];
      const line = clamp(a.line!);
      const n = stacked.get(line) ?? 0;
      stacked.set(line, n + 1);
      const opt: vscode.DecorationOptions = {
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: new vscode.MarkdownString(`**${a.label}** · ${a.detail}`),
        renderOptions: {
          after: {
            contentText: `${n ? '   ' : '    '}✦ ${a.label} · ${VERB[a.activity] ?? a.activity}`,
            color: colorOf(a.colorIndex),
            fontStyle: 'italic',
            fontWeight: '600',
          },
        },
      };
      if (!isBusy(a)) slot.idle.push(opt);
      else (this.phase ? slot.strong : slot.soft).push(opt);
      if (a.activity === 'reading' && a.endLine !== undefined && a.endLine > a.line!) {
        slot.band.push(new vscode.Range(clamp(a.line! + 1), 0, clamp(a.endLine), 0));
      }
    }

    for (const c of model.changes) {
      if (c.file !== file) continue;
      const age = (now - c.at) / FADE_MS;
      const level = Math.min(GLOW_LEVELS.length - 1, Math.floor(age * GLOW_LEVELS.length));
      per[c.colorIndex % per.length].glow[level].push(new vscode.Range(clamp(c.start), 0, clamp(c.end), 0));
    }

    this.types.forEach((t, i) => {
      const p = per[i];
      editor.setDecorations(t.markerStrong, p.strong);
      editor.setDecorations(t.markerSoft, p.soft);
      editor.setDecorations(t.markerIdle, p.idle);
      editor.setDecorations(t.band, p.band);
      t.glow.forEach((g, j) => editor.setDecorations(g, p.glow[j]));
    });
  }

  dispose() {
    for (const t of this.types) {
      t.markerStrong.dispose();
      t.markerSoft.dispose();
      t.markerIdle.dispose();
      t.band.dispose();
      t.glow.forEach((g) => g.dispose());
    }
  }
}
