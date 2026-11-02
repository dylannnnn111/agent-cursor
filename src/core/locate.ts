// Find where a piece of text sits in a file, as 0-based line numbers.

export interface LineRange {
  start: number;
  end: number;
}

export function lineAt(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function countLines(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Exact match first. If the snippet was clipped or has drifted, fall back to its
// first non-blank line, then give up rather than point at the wrong place.
export function locate(text: string | undefined, needle: string | undefined): LineRange | undefined {
  if (!text || !needle) return undefined;
  const idx = text.indexOf(needle);
  if (idx >= 0) {
    const start = lineAt(text, idx);
    const body = needle.endsWith('\n') ? needle.slice(0, -1) : needle;
    return { start, end: start + countLines(body) - 1 };
  }
  const first = needle.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
  if (!first) return undefined;
  const lines = text.split('\n');
  const hit = lines.findIndex((l) => l.includes(first));
  if (hit < 0) return undefined;
  return { start: hit, end: hit };
}
