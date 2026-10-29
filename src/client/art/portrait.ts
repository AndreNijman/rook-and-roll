// 24 x 24 head-and-shoulders portraits for the bots, built from a few
// colours and a hairstyle so each one is recognisable at a glance.

import { INK, dome, hash, img, outline, px, ramp, rect, shade, type Img } from './pixel';

export type Hair = 'short' | 'long' | 'bun' | 'spiky' | 'bald' | 'hood';

export const PORTRAIT = 24;

export function drawPortrait(look: [string, string, string], hair: Hair, seed = 0): Img {
  const [skin, hairC, shirt] = look;
  const im = img(PORTRAIT, PORTRAIT);
  const hr = ramp(hairC);

  if (hair === 'long') dome(im, 12, 13, 8, 9, hr, { flatBottom: 19 });
  dome(im, 12, 26, 10, 7, ramp(shirt));
  rect(im, 10, 16, 4, 3, shade(skin, 0.25));
  dome(im, 12, 11, 6, 7, ramp(skin));

  if (hair === 'hood') {
    // A hood frames the face instead of sitting on top of it.
    const hood = ramp(shirt);
    for (let y = 3; y < 19; y++) for (let x = 4; x < 20; x++) {
      const nx = (x + 0.5 - 12) / 8, ny = (y + 0.5 - 11) / 8.5;
      const outer = nx * nx + ny * ny <= 1;
      const fx = (x + 0.5 - 12) / 5, fy = (y + 0.5 - 12) / 5.5;
      if (outer && fx * fx + fy * fy > 1) px(im, x, y, hood[y < 9 ? 2 : 1]);
    }
  } else if (hair !== 'bald') {
    // Hair covers the top of the head down to a fringe line.
    for (let y = 3; y < 10; y++) for (let x = 5; x < 19; x++) {
      const nx = (x + 0.5 - 12) / 6.6, ny = (y + 0.5 - 10) / 7;
      if (nx * nx + ny * ny > 1) continue;
      const fringe = 7 + (hair === 'spiky' ? 0 : hash(x, 0, seed) < 0.5 ? 1 : 0);
      if (y <= fringe || x < 7 || x > 16) px(im, x, y, hr[y < 5 ? 2 : 1]);
    }
    if (hair === 'spiky') for (let x = 6; x < 18; x += 2) { px(im, x, 2, hr[2]); px(im, x + 1, 1, hr[3]); }
    if (hair === 'bun') dome(im, 12, 2.5, 3, 2.5, hr);
  } else {
    // A shine on the bald head, and a beard to make up for it.
    px(im, 9, 6, '#fffaf0');
    for (let y = 13; y < 18; y++) for (let x = 7; x < 17; x++) {
      const nx = (x + 0.5 - 12) / 5, ny = (y + 0.5 - 13) / 5;
      if (nx * nx + ny * ny <= 1 && y >= 13) px(im, x, y, hr[1]);
    }
  }

  // Face: two eyes, cheeks and a mouth.
  px(im, 9, 11, INK); px(im, 14, 11, INK);
  px(im, 9, 10, '#fffaf0', 90); px(im, 14, 10, '#fffaf0', 90);
  px(im, 8, 13, '#e86a6a', 110); px(im, 15, 13, '#e86a6a', 110);
  if (hair !== 'bald') { px(im, 11, 14, shade(skin, 0.5)); px(im, 12, 14, shade(skin, 0.5)); }
  return outline(im);
}

/** A 24 x 24 storm cloud with a lightning bolt, for the full-strength engine. */
export function drawStorm(): Img {
  const im = img(PORTRAIT, PORTRAIT);
  const cloud = ['#4e3a5e', '#7a6290', '#a898c0', '#d8d0e8'];
  dome(im, 8, 10, 6, 5, cloud);
  dome(im, 15, 8, 7, 6, cloud);
  dome(im, 12, 12, 9, 4, cloud);
  const bolt = [[13, 14], [12, 15], [11, 16], [12, 16], [13, 16], [12, 17], [11, 18], [10, 19], [11, 19], [10, 20]];
  for (const [x, y] of bolt) px(im, x, y, '#f0d060');
  px(im, 9, 10, INK); px(im, 15, 10, INK);
  return outline(im);
}
