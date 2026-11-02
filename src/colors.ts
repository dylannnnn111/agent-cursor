// One colour per agent. Picked to read on both light and dark themes.
export const PALETTE = ['#E0533F', '#4C7BD9', '#1FA392', '#D9971E', '#9A6BE0'];

export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function colorOf(index: number): string {
  return PALETTE[index % PALETTE.length];
}
