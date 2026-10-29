// The twelve chess pieces. 16 x 16 silhouettes, lit like turned wood: each
// row is a cylinder lit from the left, the crown catches the light and the
// base sits in shadow. Outlines in ink, as everywhere else.

import { INK, img, outline, px, type Img } from './pixel';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Side = 'w' | 'b';

export const SPRITE = 16;

// '#' is body, 'o' is a detail line cut into the body (slit, eye, band).
const MASKS: Record<PieceType, string[]> = {
  p: [
    '................',
    '................',
    '................',
    '................',
    '......####......',
    '.....######.....',
    '.....######.....',
    '......####......',
    '.....oooooo.....',
    '......####......',
    '......####......',
    '.....######.....',
    '....########....',
    '...##########...',
    '...oooooooooo...',
    '................',
  ],
  r: [
    '................',
    '................',
    '....##.##.##....',
    '....########....',
    '....oooooooo....',
    '.....######.....',
    '.....######.....',
    '.....######.....',
    '.....######.....',
    '.....######.....',
    '.....######.....',
    '....########....',
    '....########....',
    '...##########...',
    '...oooooooooo...',
    '................',
  ],
  n: [
    '................',
    '......#.#.......',
    '......####......',
    '.....######.....',
    '....#o######....',
    '...#########....',
    '..##########....',
    '..###o######....',
    '...#...#####....',
    '.......#####....',
    '......######....',
    '.....#######....',
    '....########....',
    '...##########...',
    '...oooooooooo...',
    '................',
  ],
  b: [
    '................',
    '.......##.......',
    '......####......',
    '.....###o##.....',
    '.....##o###.....',
    '.....######.....',
    '.....######.....',
    '......####......',
    '.....oooooo.....',
    '......####......',
    '......####......',
    '.....######.....',
    '....########....',
    '...##########...',
    '...oooooooooo...',
    '................',
  ],
  q: [
    '................',
    '..#..#.##.#..#..',
    '..#..#.##.#..#..',
    '..##.#.##.#.##..',
    '...##########...',
    '...##########...',
    '....oooooooo....',
    '.....######.....',
    '.....######.....',
    '......####......',
    '......####......',
    '.....######.....',
    '....########....',
    '...##########...',
    '...oooooooooo...',
    '................',
  ],
  k: [
    '................',
    '.......##.......',
    '.....######.....',
    '.......##.......',
    '.....######.....',
    '....########....',
    '....oooooooo....',
    '.....######.....',
    '......####......',
    '......####......',
    '.....######.....',
    '.....######.....',
    '....########....',
    '...##########...',
    '...oooooooooo...',
    '................',
  ],
};

/** Body ramps, dark -> light. White is bone, black is plum-stained wood. */
export const RAMPS: Record<Side, string[]> = {
  w: ['#a8927a', '#d2c2a4', '#efe4cc', '#fffaf0'],
  b: ['#1c1226', '#33233f', '#4e3a5e', '#7a6290'],
};

export function drawPiece(type: PieceType, side: Side): Img {
  const mask = MASKS[type];
  const r = RAMPS[side];
  const im = img(SPRITE, SPRITE);
  const top = mask.findIndex((row) => row.includes('#'));
  for (let y = 0; y < SPRITE; y++) {
    const row = mask[y];
    const left = row.search(/[#o]/);
    if (left < 0) continue;
    const right = row.length - 1 - [...row].reverse().join('').search(/[#o]/);
    const span = Math.max(1, right - left);
    for (let x = left; x <= right; x++) {
      const c = row[x];
      if (c === '.') continue;
      if (c === 'o') { px(im, x, y, side === 'w' ? r[0] : INK); continue; }
      // Cylinder lit from the upper left; the first lit row is the crown.
      const t = (x - left) / span;
      let k = t < 0.25 ? 3 : t < 0.55 ? 2 : t < 0.85 ? 1 : 0;
      if (y === top && k < 3) k++;
      if (y >= 13 && k > 0) k--;
      px(im, x, y, r[k]);
    }
  }
  return outline(im);
}

export const PIECE_TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
