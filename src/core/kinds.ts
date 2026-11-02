// Every coding agent gets its own look: a shape, a colour family and a name.
// Sessions of the same agent use shades of that colour so they stay told apart.
// Shapes are simple geometric marks, not anyone's logo.

export type Shape = 'sparkle' | 'hexagon' | 'star' | 'diamond' | 'moon' | 'triangle' | 'ring' | 'square' | 'bolt' | 'wave' | 'dot';

export interface Kind {
  id: string;
  name: string;
  shape: Shape;
  glyph: string; // one character for the explorer badge and plain-text places
  shades: [string, string, string];
}

export const KINDS: Record<string, Kind> = {
  claude: { id: 'claude', name: 'Claude', shape: 'sparkle', glyph: '✦', shades: ['#E0533F', '#F28B6E', '#B23A28'] },
  codex: { id: 'codex', name: 'Codex', shape: 'hexagon', glyph: '⬢', shades: ['#22B07D', '#5FD3A4', '#178258'] },
  gemini: { id: 'gemini', name: 'Gemini', shape: 'star', glyph: '✶', shades: ['#4C7BD9', '#86A6EE', '#2D58B5'] },
  qwen: { id: 'qwen', name: 'Qwen', shape: 'diamond', glyph: '◆', shades: ['#8B5CF6', '#B094FA', '#6A37DD'] },
  kimi: { id: 'kimi', name: 'Kimi', shape: 'moon', glyph: '◐', shades: ['#14B8A6', '#5EE0CF', '#0D8A7C'] },
  cursor: { id: 'cursor', name: 'Cursor', shape: 'triangle', glyph: '▲', shades: ['#C3CCD9', '#E6EBF2', '#8D99AB'] },
  copilot: { id: 'copilot', name: 'Copilot', shape: 'ring', glyph: '◉', shades: ['#D9971E', '#F1BC54', '#A8730F'] },
  opencode: { id: 'opencode', name: 'OpenCode', shape: 'square', glyph: '▣', shades: ['#E0559B', '#F08CC0', '#B33A78'] },
  windsurf: { id: 'windsurf', name: 'Windsurf', shape: 'wave', glyph: '≋', shades: ['#38BDF8', '#7DD3FC', '#0E8BC4'] },
  cline: { id: 'cline', name: 'Cline', shape: 'bolt', glyph: 'ϟ', shades: ['#E8C33A', '#F5DA77', '#B8951C'] },
  agent: { id: 'agent', name: 'Agent', shape: 'dot', glyph: '●', shades: ['#9AA7BD', '#C3CCDA', '#6F7C93'] },
};

export function kindOf(id: string | undefined): Kind {
  return (id && KINDS[id]) || KINDS.agent;
}

export function shadeOf(kind: string | undefined, shade: number): string {
  const k = kindOf(kind);
  return k.shades[((shade % 3) + 3) % 3];
}

// SVG path data for each shape on a 16x16 box, centred on (8, 8).
export function shapePath(shape: Shape): string {
  switch (shape) {
    case 'sparkle':
      return 'M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z';
    case 'hexagon':
      return 'M8 1.8 13.4 4.9V11.1L8 14.2 2.6 11.1V4.9Z';
    case 'star':
      return 'M8 1.5 9.3 5.8 13.6 4.8 10.6 8 13.6 11.2 9.3 10.2 8 14.5 6.7 10.2 2.4 11.2 5.4 8 2.4 4.8 6.7 5.8Z';
    case 'diamond':
      return 'M8 1.5 14.5 8 8 14.5 1.5 8Z';
    case 'moon':
      return 'M8 1.8A6.2 6.2 0 1 0 8 14.2 6.2 6.2 0 1 0 8 1.8ZM8 3.6V12.4A4.4 4.4 0 0 1 8 3.6Z';
    case 'triangle':
      return 'M8 2 14.3 13.2H1.7Z';
    case 'ring':
      return 'M8 1.8A6.2 6.2 0 1 0 8 14.2 6.2 6.2 0 1 0 8 1.8ZM8 5A3 3 0 1 1 8 11 3 3 0 1 1 8 5Z';
    case 'square':
      return 'M2.5 2.5H13.5V13.5H2.5ZM5.5 5.5V10.5H10.5V5.5Z';
    case 'wave':
      return 'M1.5 5.2C3.5 3.4 5.5 3.4 8 5.2S12.5 7 14.5 5.2V7.6C12.5 9.4 10.5 9.4 8 7.6S3.5 5.8 1.5 7.6ZM1.5 9.6C3.5 7.8 5.5 7.8 8 9.6S12.5 11.4 14.5 9.6V12C12.5 13.8 10.5 13.8 8 12S3.5 10.2 1.5 12Z';
    case 'bolt':
      return 'M9.5 1.5 3.5 9H7.5L6.5 14.5 12.5 7H8.5Z';
    default:
      return 'M8 3A5 5 0 1 0 8 13 5 5 0 1 0 8 3Z';
  }
}

// Which agents Agent Cursor can connect to, in the order the Connect menu lists them.
export const CONNECTABLE = ['claude', 'codex', 'gemini', 'qwen', 'cursor', 'copilot', 'opencode', 'kimi', 'windsurf'];
