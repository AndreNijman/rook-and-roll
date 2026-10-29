// Renders the pieces on every board theme to a PNG, scaled up, so the art can
// be looked at without running the game: `npm run sheet [out.png]`.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { THEMES, drawSquare, glyph } from '../src/client/art/board';
import { PIECE_TYPES, SPRITE, drawPiece } from '../src/client/art/pieces';
import { blit, img, type Img } from '../src/client/art/pixel';

const SCALE = 4;
const cols = PIECE_TYPES.length * 2;
const sheet = img(cols * SPRITE, THEMES.length * SPRITE * 2);
THEMES.forEach((theme, t) => {
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < cols; i++) {
      const x = i * SPRITE, y = (t * 2 + row) * SPRITE;
      blit(sheet, drawSquare(theme, (i + row) % 2 === 0, i * 8 + row), x, y);
      const side = i < PIECE_TYPES.length ? 'w' : 'b';
      blit(sheet, drawPiece(PIECE_TYPES[i % PIECE_TYPES.length], side), x, y);
    }
  }
  glyph(sheet, 'abcdefgh'[t], 1, t * SPRITE * 2 + 1, '#26181e');
});

writeFileSync(process.argv[2] || 'sheet.png', png(scale(sheet, SCALE)));

function scale(im: Img, k: number): Img {
  const out = img(im.w * k, im.h * k);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
    const s = (((y / k) | 0) * im.w + ((x / k) | 0)) * 4, d = (y * out.w + x) * 4;
    out.data.set(im.data.subarray(s, s + 4), d);
  }
  return out;
}

function png(im: Img): Buffer {
  const raw = Buffer.alloc((im.w * 4 + 1) * im.h);
  for (let y = 0; y < im.h; y++) Buffer.from(im.data.buffer, y * im.w * 4, im.w * 4).copy(raw, y * (im.w * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(im.w, 0); head.writeUInt32BE(im.h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
