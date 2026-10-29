// The board on a 128 x 128 canvas, one 16 px sprite per square, scaled up
// with nearest-neighbour so every highlight, dot and arrow is drawn in the
// same chunky pixels as the pieces. It knows nothing about the rules: the
// game hands it the pieces and the legal destinations, and hears back moves.

import type { Square } from 'chess.js';
import { THEMES, drawSquare, glyph, type BoardTheme } from '../art/board';
import { SPRITE, drawPiece, type PieceType, type Side } from '../art/pieces';
import { INK, toCanvas } from '../art/pixel';

export interface Piece { type: PieceType; color: Side }
export type Pieces = Map<Square, Piece>;
export interface Arrow { from: Square; to: Square; color?: string }

export interface BoardState {
  pieces: Pieces;
  /** Legal destinations for the pieces the player may move now. */
  dests?: Map<Square, Square[]>;
  lastMove?: [Square, Square] | null;
  check?: Square | null;
}

const S = SPRITE;
const W = S * 8;
const FILES = 'abcdefgh';
const PROMO: PieceType[] = ['q', 'n', 'r', 'b'];
const SLIDE_MS = 150;

const fileOf = (sq: Square) => FILES.indexOf(sq[0]);
const rankOf = (sq: Square) => Number(sq[1]);
const same = (a?: Piece, b?: Piece) => !!a && !!b && a.type === b.type && a.color === b.color;

interface Slide { piece: Piece; from: Square; to: Square }

export class BoardView {
  readonly canvas = document.createElement('canvas');
  onMove: (from: Square, to: Square, promotion?: PieceType) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement('canvas');
  private theme: BoardTheme = THEMES[0];
  private bg: HTMLCanvasElement | null = null;
  private sprites = new Map<string, HTMLCanvasElement>();
  private orientation: Side = 'w';
  private state: Required<BoardState> = { pieces: new Map(), dests: new Map(), lastMove: null, check: null };
  private arrows: Arrow[] = [];
  private drawn: Arrow[] = [];
  private selected: Square | null = null;
  private wasSelected = false;
  private drag: { from: Square; x: number; y: number; moved: boolean } | null = null;
  private rightFrom: Square | null = null;
  private promo: { from: Square; to: Square; color: Side } | null = null;
  private slides: Slide[] = [];
  private slideStart = 0;
  private dropped: Square | null = null;
  private raf = 0;

  constructor(private host: HTMLElement) {
    this.canvas.width = this.canvas.height = W;
    this.layer.width = this.layer.height = W;
    this.canvas.className = 'board';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Chess board');
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    host.append(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; this.rightFrom = null; this.draw(); });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // The host is not in the page yet; size it once it is, and on resizes.
    const watch = new ResizeObserver(() => this.fit());
    requestAnimationFrame(() => { if (host.parentElement) watch.observe(host.parentElement); this.fit(); });
  }

  set(state: BoardState, animate = true): void {
    const prev = this.state.pieces;
    this.state = { dests: new Map(), lastMove: null, check: null, ...state };
    if (this.selected && !this.state.dests.has(this.selected)) this.selected = null;
    this.promo = null;
    this.slides = animate ? this.diff(prev, state.pieces) : [];
    this.slideStart = performance.now();
    this.draw();
  }

  setOrientation(side: Side): void {
    if (side === this.orientation) return;
    this.orientation = side;
    this.bg = null;
    this.draw();
  }

  get side(): Side { return this.orientation; }
  flip(): void { this.setOrientation(this.orientation === 'w' ? 'b' : 'w'); }

  setTheme(theme: BoardTheme): void { this.theme = theme; this.bg = null; this.draw(); }

  /** Arrows owned by the game (hints, the engine's best line). */
  setArrows(arrows: Arrow[]): void { this.arrows = arrows; this.draw(); }

  clearDrawn(): void { this.drawn = []; this.draw(); }

  /**
   * Size the board to the space its parent leaves after the other children
   * (player bars, eval bar). A whole-number scale keeps pixels square; it is
   * used unless it would waste more than an eighth of the room. The size is
   * published as --board so the bars can match it.
   */
  private fit(): void {
    const frame = this.host.parentElement;
    if (!frame) return;
    const cs = getComputedStyle(frame);
    const row = cs.flexDirection === 'row';
    const gap = parseFloat(row ? cs.columnGap : cs.rowGap) || 0;
    let used = 0;
    for (const c of frame.children) {
      if (c === this.host || !(c instanceof HTMLElement)) continue;
      const m = getComputedStyle(c), r = c.getBoundingClientRect();
      used += gap + (row ? r.width + parseFloat(m.marginLeft) + parseFloat(m.marginRight) : r.height + parseFloat(m.marginTop) + parseFloat(m.marginBottom));
    }
    // Room for the frame drawn around the board.
    const edge = 24;
    const narrow = matchMedia('(max-width: 860px)').matches;
    const w = frame.clientWidth - (row ? used : 0) - edge;
    const h = narrow ? Infinity : frame.clientHeight - (row ? 0 : used) - edge;
    const box = Math.max(64, Math.floor(Math.min(w, h)));
    const k = Math.floor(box / W);
    const size = k >= 1 && k * W >= box * 0.88 ? k * W : Math.floor(box / 8) * 8;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    frame.style.setProperty('--board', `${size}px`);
  }

  // ---------- geometry ----------

  private xy(sq: Square): [number, number] {
    const f = fileOf(sq), r = rankOf(sq);
    return this.orientation === 'w' ? [f * S, (8 - r) * S] : [(7 - f) * S, (r - 1) * S];
  }

  private squareAt(x: number, y: number): Square | null {
    const c = Math.floor(x / S), r = Math.floor(y / S);
    if (c < 0 || c > 7 || r < 0 || r > 7) return null;
    return (this.orientation === 'w' ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1)) as Square;
  }

  private local(e: PointerEvent): [number, number] {
    const b = this.canvas.getBoundingClientRect();
    return [((e.clientX - b.left) * W) / b.width, ((e.clientY - b.top) * W) / b.height];
  }

  /** Promotion choices stack inward from the edge the pawn lands on. */
  private promoSquares(): Square[] {
    if (!this.promo) return [];
    const { to, color } = this.promo;
    const step = color === 'w' ? -1 : 1;
    return PROMO.map((_, i) => (to[0] + (rankOf(to) + step * i)) as Square);
  }

  // ---------- input ----------

  private down(e: PointerEvent): void {
    const [x, y] = this.local(e);
    const sq = this.squareAt(x, y);
    if (e.button === 2) { this.rightFrom = sq; return; }
    if (e.button !== 0) return;
    this.drawn = [];
    if (this.promo) {
      const i = sq ? this.promoSquares().indexOf(sq) : -1;
      const { from, to } = this.promo;
      this.promo = null;
      if (i >= 0) this.onMove(from, to, PROMO[i]);
      this.draw();
      return;
    }
    if (!sq) return;
    if (this.selected && this.state.dests.get(this.selected)?.includes(sq)) {
      this.tryMove(this.selected, sq);
      return;
    }
    if (this.state.dests.has(sq)) {
      this.wasSelected = this.selected === sq;
      this.selected = sq;
      this.drag = { from: sq, x, y, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    } else {
      this.selected = null;
    }
    this.draw();
  }

  private move(e: PointerEvent): void {
    if (!this.drag) return;
    const [x, y] = this.local(e);
    if (Math.hypot(x - this.drag.x, y - this.drag.y) > 2) this.drag.moved = true;
    this.drag.x = x;
    this.drag.y = y;
    this.draw();
  }

  private up(e: PointerEvent): void {
    const [x, y] = this.local(e);
    const sq = this.squareAt(x, y);
    if (e.button === 2 && this.rightFrom) {
      if (sq) this.toggleDrawn(this.rightFrom, sq);
      this.rightFrom = null;
      this.draw();
      return;
    }
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.moved) {
      if (sq && sq !== drag.from && this.state.dests.get(drag.from)?.includes(sq)) {
        this.dropped = sq;
        this.tryMove(drag.from, sq);
      } else if (sq !== drag.from) {
        this.selected = null;
      }
    } else if (this.wasSelected) {
      this.selected = null;
    }
    this.draw();
  }

  private toggleDrawn(from: Square, to: Square): void {
    const i = this.drawn.findIndex((a) => a.from === from && a.to === to);
    if (i >= 0) this.drawn.splice(i, 1);
    else this.drawn.push({ from, to });
  }

  private tryMove(from: Square, to: Square): void {
    const piece = this.state.pieces.get(from);
    this.selected = null;
    if (piece?.type === 'p' && (rankOf(to) === 8 || rankOf(to) === 1)) {
      this.promo = { from, to, color: piece.color };
      this.draw();
      return;
    }
    this.onMove(from, to);
  }

  // ---------- animation ----------

  /** Pieces that moved between two positions, matched to the nearest twin. */
  private diff(prev: Pieces, next: Pieces): Slide[] {
    const gone = [...prev].filter(([sq, p]) => !same(next.get(sq), p));
    const slides: Slide[] = [];
    for (const [sq, p] of next) {
      if (same(prev.get(sq), p)) continue;
      let best = -1, dist = Infinity;
      gone.forEach(([g, gp], i) => {
        const d = Math.hypot(fileOf(g) - fileOf(sq), rankOf(g) - rankOf(sq));
        if (same(gp, p) && d < dist) { dist = d; best = i; }
      });
      if (best < 0) continue;
      const from = gone.splice(best, 1)[0][0];
      // The player already put this piece down by hand.
      if (sq !== this.dropped) slides.push({ piece: p, from, to: sq });
    }
    this.dropped = null;
    return slides;
  }

  // ---------- drawing ----------

  private sprite(p: Piece): HTMLCanvasElement {
    const key = p.color + p.type;
    let c = this.sprites.get(key);
    if (!c) this.sprites.set(key, (c = toCanvas(drawPiece(p.type, p.color))));
    return c;
  }

  private background(): HTMLCanvasElement {
    if (this.bg) return this.bg;
    const c = document.createElement('canvas');
    c.width = c.height = W;
    const g = c.getContext('2d')!;
    for (let f = 0; f < 8; f++) for (let r = 1; r <= 8; r++) {
      const sq = (FILES[f] + r) as Square;
      const light = (f + r) % 2 === 0;
      const im = drawSquare(this.theme, light, f * 8 + r);
      const [x, y] = this.xy(sq);
      const ink = light ? this.theme.dark : this.theme.light;
      // Rank numbers down the left edge, file letters along the bottom.
      if (x === 0) glyph(im, String(r), 1, 1, ink);
      if (y === W - S) glyph(im, FILES[f], S - 4, S - 6, ink);
      g.drawImage(toCanvas(im), x, y);
    }
    return (this.bg = c);
  }

  private draw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  private tint(sq: Square, color: string, alpha: number): void {
    const [x, y] = this.xy(sq);
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, S, S);
    this.ctx.globalAlpha = 1;
  }

  private paint(): void {
    const g = this.ctx;
    const { pieces, dests, lastMove, check } = this.state;
    g.drawImage(this.background(), 0, 0);

    if (lastMove) for (const sq of lastMove) this.tint(sq, this.theme.moved, 0.42);
    if (this.selected) this.tint(this.selected, this.theme.select, 0.5);
    if (check) this.paintCheck(check);

    const t = Math.min(1, (performance.now() - this.slideStart) / SLIDE_MS);
    const ease = 1 - (1 - t) ** 3;
    const sliding = t < 1 ? new Map(this.slides.map((s) => [s.to, s])) : new Map<Square, Slide>();

    for (const [sq, p] of pieces) {
      if (sliding.has(sq)) continue;
      const [x, y] = this.xy(sq);
      if (this.drag?.moved && this.drag.from === sq) g.globalAlpha = 0.3;
      g.drawImage(this.sprite(p), x, y);
      g.globalAlpha = 1;
    }
    for (const s of sliding.values()) {
      const [x0, y0] = this.xy(s.from), [x1, y1] = this.xy(s.to);
      g.drawImage(this.sprite(s.piece), Math.round(x0 + (x1 - x0) * ease), Math.round(y0 + (y1 - y0) * ease));
    }

    const from = this.drag?.moved ? this.drag.from : this.selected;
    if (from) for (const to of dests.get(from) ?? []) this.paintDest(to, pieces.has(to));
    if (this.drag?.moved) {
      const over = this.squareAt(this.drag.x, this.drag.y);
      if (over && dests.get(this.drag.from)?.includes(over)) this.paintFrame(over, this.theme.select);
    }

    this.paintArrows([...this.arrows, ...this.drawn]);

    if (this.drag?.moved) {
      const p = pieces.get(this.drag.from);
      if (p) g.drawImage(this.sprite(p), Math.round(this.drag.x - S / 2), Math.round(this.drag.y - S + 3));
    }
    if (this.promo) this.paintPromo();
    if (t < 1) this.draw();
  }

  private paintCheck(sq: Square): void {
    const [x, y] = this.xy(sq);
    const g = this.ctx;
    g.fillStyle = this.theme.check;
    // A stepped glow: solid core, fading rings out to the square's edge.
    for (let ring = 0; ring < 4; ring++) {
      g.globalAlpha = 0.2 + ring * 0.17;
      const i = ring * 2;
      g.fillRect(x + i, y + i, S - i * 2, S - i * 2);
    }
    g.globalAlpha = 1;
  }

  private paintDest(sq: Square, capture: boolean): void {
    const [x, y] = this.xy(sq);
    const g = this.ctx;
    g.fillStyle = INK;
    g.globalAlpha = 0.28;
    if (capture) {
      // Four corner wedges, so the target piece stays visible.
      for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [S - 1, 0, -1, 1], [0, S - 1, 1, -1], [S - 1, S - 1, -1, -1]]) {
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4 - i; j++) g.fillRect(x + cx + dx * i, y + cy + dy * j, 1, 1);
      }
    } else {
      g.fillRect(x + 6, y + 7, 4, 2);
      g.fillRect(x + 7, y + 6, 2, 4);
    }
    g.globalAlpha = 1;
  }

  private paintFrame(sq: Square, color: string): void {
    const [x, y] = this.xy(sq);
    const g = this.ctx;
    g.fillStyle = color;
    g.fillRect(x, y, S, 1); g.fillRect(x, y + S - 1, S, 1);
    g.fillRect(x, y, 1, S); g.fillRect(x + S - 1, y, 1, S);
  }

  /** Arrows go on their own layer first so overlapping strokes don't stack alpha. */
  private paintArrows(arrows: Arrow[]): void {
    if (!arrows.length) return;
    const l = this.layer.getContext('2d')!;
    for (const color of new Set(arrows.map((a) => a.color ?? this.theme.arrow))) {
      l.clearRect(0, 0, W, W);
      l.fillStyle = color;
      for (const a of arrows) if ((a.color ?? this.theme.arrow) === color) this.arrow(l, a);
      this.ctx.globalAlpha = 0.78;
      this.ctx.drawImage(this.layer, 0, 0);
      this.ctx.globalAlpha = 1;
    }
  }

  private arrow(l: CanvasRenderingContext2D, a: Arrow): void {
    const [fx, fy] = this.xy(a.from), [tx, ty] = this.xy(a.to);
    const x0 = fx + S / 2, y0 = fy + S / 2, x1 = tx + S / 2, y1 = ty + S / 2;
    if (a.from === a.to) {
      // A ring marks a square.
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const d = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2);
        if (d >= 6 && d < 7.5) l.fillRect(fx + x, fy + y, 1, 1);
      }
      return;
    }
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    const head = 6, half = 4;
    const bx = x1 - ux * head, by = y1 - uy * head;
    for (let d = 3; d <= len - head; d += 0.5) l.fillRect(Math.round(x0 + ux * d - 1), Math.round(y0 + uy * d - 1), 2, 2);
    const tri: [number, number][] = [[x1, y1], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
    const xs = tri.map((p) => p[0]), ys = tri.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        if (inside(x + 0.5, y + 0.5, tri)) l.fillRect(x, y, 1, 1);
      }
    }
  }

  private paintPromo(): void {
    const g = this.ctx;
    g.globalAlpha = 0.55;
    g.fillStyle = INK;
    g.fillRect(0, 0, W, W);
    g.globalAlpha = 1;
    this.promoSquares().forEach((sq, i) => {
      const [x, y] = this.xy(sq);
      g.fillStyle = '#fbf3e4';
      g.fillRect(x, y, S, S);
      g.fillStyle = '#e8dcc4';
      g.fillRect(x, y + S - 2, S, 2);
      g.drawImage(this.sprite({ type: PROMO[i], color: this.promo!.color }), x, y);
    });
  }
}

function inside(px: number, py: number, [a, b, c]: [number, number][]): boolean {
  const s = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
