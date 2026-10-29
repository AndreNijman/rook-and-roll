// Pixel image primitives for the procedural art. Same conventions as FART
// TOGETHER and Stinkwater: ramps run dark -> light, shadows lean cool
// (#2a2050), lights lean warm (#fff0c0), outlines in ink #26181e.

export interface Img { w: number; h: number; data: Uint8ClampedArray }

export const INK = '#26181e';
const COOL = '#2a2050';
const WARM = '#fff0c0';

const cache = new Map<string, [number, number, number]>();
export function rgb(hex: string): [number, number, number] {
  let v = cache.get(hex);
  if (!v) {
    let s = hex.replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s, 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    cache.set(hex, v);
  }
  return v;
}
export function hex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
export function mix(a: string, b: string, t: number): string {
  const A = rgb(a), B = rgb(b);
  return hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
export const shade = (c: string, t: number) => mix(c, COOL, t);
export const lite = (c: string, t: number) => mix(c, WARM, t);
/** n-step ramp around `mid`, dark -> light. */
export function ramp(mid: string, n = 4, spread = 0.5): string[] {
  const out: string[] = [];
  const mi = Math.floor((n - 1) / 2);
  for (let i = 0; i < n; i++) {
    if (i === mi) out.push(mid);
    else if (i < mi) out.push(shade(mid, ((mi - i) / Math.max(1, mi)) * spread * 0.75));
    else out.push(lite(mid, ((i - mi) / Math.max(1, n - 1 - mi)) * spread * 0.75));
  }
  return out;
}

export function img(w: number, h: number): Img {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function px(im: Img, x: number, y: number, c: string, a = 255): void {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const i = (y * im.w + x) * 4;
  const [r, g, b] = rgb(c);
  if (a >= 255) { im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = 255; return; }
  const k = a / 255, ia = im.data[i + 3] / 255;
  const oa = k + ia * (1 - k);
  if (oa <= 0) return;
  im.data[i] = (r * k + im.data[i] * ia * (1 - k)) / oa;
  im.data[i + 1] = (g * k + im.data[i + 1] * ia * (1 - k)) / oa;
  im.data[i + 2] = (b * k + im.data[i + 2] * ia * (1 - k)) / oa;
  im.data[i + 3] = oa * 255;
}

export const alphaAt = (im: Img, x: number, y: number) => (x < 0 || y < 0 || x >= im.w || y >= im.h ? 0 : im.data[(y * im.w + x) * 4 + 3]);

export function rect(im: Img, x: number, y: number, w: number, h: number, c: string, a = 255): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(im, x + i, y + j, c, a);
}

/**
 * Filled ellipse shaded as a lit dome: `ramp` picks by a light term from the
 * upper left, so round things read as round.
 */
export function dome(im: Img, cx: number, cy: number, rx: number, ry: number, r: string[], opts: { flatBottom?: number } = {}): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      if (opts.flatBottom !== undefined && y > opts.flatBottom) continue;
      const nz = Math.sqrt(Math.max(0, 1 - d));
      const l = -0.55 * nx - 0.65 * ny + 0.55 * nz;
      const k = Math.max(0, Math.min(r.length - 1, Math.floor((l * 0.5 + 0.5) * r.length * 1.05)));
      px(im, x, y, r[k]);
    }
  }
}

export function disc(im: Img, cx: number, cy: number, rad: number, c: string, a = 255): void {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= rad * rad) px(im, x, y, c, a);
    }
  }
}

export function line(im: Img, x0: number, y0: number, x1: number, y1: number, c: string): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let k = 0; k <= n; k++) px(im, Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), c);
}

/** Draw an ink outline around every opaque pixel (4-neighbour). */
export function outline(im: Img, c = INK): Img {
  const out = img(im.w, im.h);
  out.data.set(im.data);
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < im.w; x++) {
      if (alphaAt(im, x, y) > 0) continue;
      if (alphaAt(im, x - 1, y) > 128 || alphaAt(im, x + 1, y) > 128 || alphaAt(im, x, y - 1) > 128 || alphaAt(im, x, y + 1) > 128) px(out, x, y, c);
    }
  }
  return out;
}

export function flipX(im: Img): Img {
  const out = img(im.w, im.h);
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const s = (y * im.w + x) * 4, d = (y * im.w + (im.w - 1 - x)) * 4;
    out.data[d] = im.data[s]; out.data[d + 1] = im.data[s + 1]; out.data[d + 2] = im.data[s + 2]; out.data[d + 3] = im.data[s + 3];
  }
  return out;
}

/** Blit `src` into `dst` at (x, y), alpha-composited. */
export function blit(dst: Img, src: Img, x: number, y: number): void {
  for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) {
    const s = (j * src.w + i) * 4;
    const a = src.data[s + 3];
    if (!a) continue;
    px(dst, x + i, y + j, hex(src.data[s], src.data[s + 1], src.data[s + 2]), a);
  }
}

/** Deterministic hash noise in [0, 1). */
export function hash(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function toCanvas(im: Img): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = im.w;
  c.height = im.h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(im.w, im.h);
  id.data.set(im.data);
  ctx.putImageData(id, 0, 0);
  return c;
}
