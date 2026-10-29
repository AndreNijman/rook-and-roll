// The board: 8 x 8 squares of 16 px, inlaid wood with a little grain, and a
// 3 x 5 pixel font for the file and rank labels in the corners.

import { hash, img, mix, px, rect, type Img } from './pixel';
import { SPRITE } from './pieces';

export interface BoardTheme {
  name: string;
  light: string;
  dark: string;
  /** Last move, selected square, hint/best-move arrows, check. */
  moved: string;
  select: string;
  arrow: string;
  check: string;
}

export const THEMES: BoardTheme[] = [
  { name: 'Walnut', light: '#ecd6ac', dark: '#a8744c', moved: '#f0d060', select: '#8ad05a', arrow: '#e86a3a', check: '#d8484a' },
  { name: 'Moss', light: '#e8e4c4', dark: '#6e9a5e', moved: '#f0d060', select: '#5ab0d8', arrow: '#e86a3a', check: '#d8484a' },
  { name: 'Dusk', light: '#d8d0e8', dark: '#7a6aa8', moved: '#f0d060', select: '#8ad05a', arrow: '#e86a3a', check: '#d8484a' },
  { name: 'Ice', light: '#e4f0f6', dark: '#7ab0d0', moved: '#f0d060', select: '#8ad05a', arrow: '#e86a3a', check: '#d8484a' },
];

export function drawSquare(theme: BoardTheme, light: boolean, seed: number): Img {
  const base = light ? theme.light : theme.dark;
  const im = img(SPRITE, SPRITE);
  rect(im, 0, 0, SPRITE, SPRITE, base);
  // Grain runs along the rows, broken every few pixels, so squares read as
  // inlaid pieces rather than flat fills.
  for (let y = 0; y < SPRITE; y++) {
    const band = hash(seed, y, 7);
    if (band < 0.55) continue;
    const c = mix(base, light ? '#b89464' : '#5a3a28', light ? 0.18 : 0.22);
    for (let x = 0; x < SPRITE; x++) if (hash(x >> 2, y, seed) < 0.7) px(im, x, y, c);
  }
  return im;
}

// 3 x 5 glyphs for a-h and 1-8, one string per row.
const GLYPHS: Record<string, string[]> = {
  a: ['...', '.##', '#.#', '#.#', '.##'],
  b: ['#..', '##.', '#.#', '#.#', '##.'],
  c: ['...', '.##', '#..', '#..', '.##'],
  d: ['..#', '.##', '#.#', '#.#', '.##'],
  e: ['...', '.#.', '###', '#..', '.##'],
  f: ['.##', '#..', '##.', '#..', '#..'],
  g: ['.##', '#.#', '.##', '..#', '##.'],
  h: ['#..', '##.', '#.#', '#.#', '#.#'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '##.', '#.#', '.#.'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['.#.', '#.#', '.#.', '#.#', '.#.'],
};

export function glyph(im: Img, ch: string, x: number, y: number, c: string): void {
  const g = GLYPHS[ch];
  if (!g) return;
  g.forEach((row, j) => [...row].forEach((v, i) => { if (v === '#') px(im, x + i, y + j, c); }));
}
