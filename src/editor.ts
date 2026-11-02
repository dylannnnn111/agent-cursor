// Draws the agents in the editor: a marker on the line each agent is on (with
// its agent's shape in the gutter), a soft band over what it's reading, and a
// glow on lines it just changed that fades out over a few seconds.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { rgba } from './colors';
import { kindOf, shapePath } from './core/kinds';
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

interface Types {
  markerStrong: vscode.TextEditorDecorationType;
  markerSoft: vscode.TextEditorDecorationType;
  markerIdle: vscode.TextEditorDecorationType;
  band: vscode.TextEditorDecorationType;
  glow: vscode.TextEditorDecorationType[];
}

interface Bucket {
  strong: vscode.DecorationOptions[];
  soft: vscode.DecorationOptions[];
  idle: vscode.DecorationOptions[];
  band: vscode.Range[];
  glow: vscode.Range[][];
}

export class EditorView implements vscode.Disposable {
  // decoration types are made the first time a kind+colour shows up
  private types = new Map<string, Types>();
  private phase = false;
  private iconDir: string;

  constructor(storageDir: string) {
    this.iconDir = path.join(storageDir, 'icons');
    fs.mkdirSync(this.iconDir, { recursive: true });
  }

  private icon(kind: string, color: string): vscode.Uri {
    const file = path.join(this.iconDir, `${kind}-${color.slice(1)}.svg`);
    if (!fs.existsSync(file)) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
        `<circle cx="8" cy="8" r="7.5" fill="${color}" fill-opacity="0.22"/>` +
        `<path d="${shapePath(kindOf(kind).shape)}" fill="${color}" fill-rule="evenodd"/></svg>`;
      fs.writeFileSync(file, svg);
    }
    return vscode.Uri.file(file);
  }

  private typesFor(kind: string, c: string): Types {
    const key = `${kind}|${c}`;
    let t = this.types.get(key);
    if (t) return t;
    const icon = this.icon(kind, c);
    const marker = (bg: number, border: number): vscode.DecorationRenderOptions => ({
      isWholeLine: true,
      backgroundColor: rgba(c, bg),
      borderColor: rgba(c, border),
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      gutterIconPath: icon,
      gutterIconSize: '85%',
      overviewRulerColor: c,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    t = {
      markerStrong: vscode.window.createTextEditorDecorationType(marker(0.2, 1)),
      markerSoft: vscode.window.createTextEditorDecorationType(marker(0.1, 0.55)),
      markerIdle: vscode.window.createTextEditorDecorationType({ ...marker(0.05, 0.35), overviewRulerColor: rgba(c, 0.4) }),
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
    this.types.set(key, t);
    return t;
  }

  render(model: Model, now: number) {
    this.phase = !this.phase;
    // make sure every colour on screen has its types before drawing
    for (const a of model.agents.values()) this.typesFor(a.kind, a.color);
    for (const c of model.changes) this.typesFor(c.kind, c.color);
    for (const editor of vscode.window.visibleTextEditors) this.renderEditor(editor, model, now);
  }

  private renderEditor(editor: vscode.TextEditor, model: Model, now: number) {
    const file = editor.document.uri.fsPath;
    const last = editor.document.lineCount - 1;
    const clamp = (l: number) => Math.max(0, Math.min(l, last));
    const buckets = new Map<string, Bucket>();
    const bucket = (kind: string, color: string) => {
      const key = `${kind}|${color}`;
      let b = buckets.get(key);
      if (!b) {
        b = { strong: [], soft: [], idle: [], band: [], glow: GLOW_LEVELS.map(() => []) };
        buckets.set(key, b);
      }
      return b;
    };

    const stacked = new Map<number, number>();
    for (const a of model.agents.values()) {
      if (a.file !== file || a.line === undefined) continue;
      const b = bucket(a.kind, a.color);
      const line = clamp(a.line);
      const n = stacked.get(line) ?? 0;
      stacked.set(line, n + 1);
      const glyph = kindOf(a.kind).glyph;
      const opt: vscode.DecorationOptions = {
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: new vscode.MarkdownString(`**${a.label}**${a.model ? ` (${a.model})` : ''} · ${a.detail}`),
        renderOptions: {
          after: {
            contentText: `${n ? '   ' : '    '}${glyph} ${a.label} · ${VERB[a.activity] ?? a.activity}`,
            color: a.color,
            fontStyle: 'italic',
            fontWeight: '600',
          },
        },
      };
      if (!isBusy(a)) b.idle.push(opt);
      else (this.phase ? b.strong : b.soft).push(opt);
      if (a.activity === 'reading' && a.endLine !== undefined && a.endLine > a.line) {
        b.band.push(new vscode.Range(clamp(a.line + 1), 0, clamp(a.endLine), 0));
      }
    }

    for (const c of model.changes) {
      if (c.file !== file) continue;
      const age = (now - c.at) / FADE_MS;
      const level = Math.min(GLOW_LEVELS.length - 1, Math.floor(age * GLOW_LEVELS.length));
      bucket(c.kind, c.color).glow[level].push(new vscode.Range(clamp(c.start), 0, clamp(c.end), 0));
    }

    // every known type gets set each time, so old decorations clear
    for (const [key, t] of this.types) {
      const b = buckets.get(key);
      editor.setDecorations(t.markerStrong, b?.strong ?? []);
      editor.setDecorations(t.markerSoft, b?.soft ?? []);
      editor.setDecorations(t.markerIdle, b?.idle ?? []);
      editor.setDecorations(t.band, b?.band ?? []);
      t.glow.forEach((g, j) => editor.setDecorations(g, b?.glow[j] ?? []));
    }
  }

  dispose() {
    for (const t of this.types.values()) {
      t.markerStrong.dispose();
      t.markerSoft.dispose();
      t.markerIdle.dispose();
      t.band.dispose();
      t.glow.forEach((g) => g.dispose());
    }
  }
}
