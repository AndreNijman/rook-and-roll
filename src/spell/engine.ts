// Spell Chess rules engine. Pure functions over a JSON-serialisable State:
// decks, hands, active effects, durations, the last spell cast and the RNG
// all live in the state, so undo (keep old states), save/load (JSON) and
// repetition checks need nothing else. It does not use chess.js: walls,
// phantoms and spells that move or remove pieces need their own rules.
//
// Squares are 0..63, a1 = 0, h1 = 7, a8 = 56. Plies count turns (one per
// player turn); an effect cast on ply P by its caster has `until` set to the
// ply at whose START it disappears (P+2 is the caster's next turn).

export type Color = 'w' | 'b';
export type PT = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece { readonly t: PT; readonly c: Color; readonly id: number; readonly ghost?: boolean }
type Cell = Piece | null;

export const SPELL_IDS = [
  'frost', 'phantom', 'alarm', 'transpose', 'blink', 'wall', 'aegis', 'surge', 'shapeshift',
  'revive', 'gust', 'timeslip', 'trap', 'smite', 'leap', 'charm', 'silence', 'echo',
] as const;
export type SpellId = (typeof SPELL_IDS)[number];

export interface Fx {
  frost: { by: Color; ids: number[]; until: number }[];
  walls: { by: Color; a: number; b: number; until: number }[];
  aegis: { by: Color; id: number; until: number }[];
  /** A trap covers one square, or two adjacent ones (`sq2`). */
  traps: { by: Color; sq: number; sq2?: number; until: number }[];
  phantoms: { by: Color; id: number; placed: number; until: number }[];
  alarm: { by: Color; on: Color; until: number; forced: boolean }[];
  silence: { on: Color; until: number }[];
}

export interface Flags { cast: boolean; moved: boolean; leap: boolean; blinked: number | null }
export interface Result { winner: Color | null; reason: string }
export interface LastMove { by: Color; from: number; to: number; id: number; plain: boolean }

export interface State {
  board: Cell[];
  turn: Color;
  ply: number;
  full: number;
  half: number;
  castle: Record<Color, { k: boolean; q: boolean }>;
  ep: number;
  nextId: number;
  rng: number;
  decks: Record<Color, SpellId[]>;
  hands: Record<Color, SpellId[]>;
  lost: Record<Color, number>;
  fx: Fx;
  last: Record<Color, LastMove | null>;
  lastCast: Record<Color, SpellId | null>;
  flags: Flags;
  pending: { color: Color } | null;
  result: Result | null;
  reps: Record<string, number>;
}

export interface Move {
  from: number;
  to: number;
  kind: 'n' | 'cap' | 'ep' | 'dbl' | 'castle';
  promo?: 'q' | 'r' | 'b' | 'n';
  jump?: boolean;
}

/** A spell and its targets. For Echo, `as` is the copied spell. */
export interface Cast { spell: SpellId; at: number[]; as?: SpellId }

export const HAND_LIMIT = 3;
export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
export const fileOf = (i: number) => i & 7;
export const rankOf = (i: number) => i >> 3;
export const sqName = (i: number) => 'abcdefgh'[i & 7] + ((i >> 3) + 1);
export const sqIdx = (n: string) => n.charCodeAt(0) - 97 + (Number(n[1]) - 1) * 8;
const inB = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
const dirOf = (c: Color) => (c === 'w' ? 1 : -1);

const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL8 = [...ORTH, ...DIAG];

// ---------- state construction ----------

function rnd(s: State): number {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = Math.imul(s.rng ^ (s.rng >>> 15), 1 | s.rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle<T>(s: State, a: T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd(s) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function emptyFx(): Fx {
  return { frost: [], walls: [], aegis: [], traps: [], phantoms: [], alarm: [], silence: [] };
}

function blank(seed: number): State {
  return {
    board: new Array<Cell>(64).fill(null), turn: 'w', ply: 0, full: 1, half: 0,
    castle: { w: { k: false, q: false }, b: { k: false, q: false } },
    ep: -1, nextId: 1, rng: seed | 0, decks: { w: [], b: [] }, hands: { w: [], b: [] }, lost: { w: 0, b: 0 },
    fx: emptyFx(), last: { w: null, b: null }, lastCast: { w: null, b: null },
    flags: { cast: false, moved: false, leap: false, blinked: null },
    pending: null, result: null, reps: {},
  };
}

export function newGame(seed = (Math.random() * 2 ** 32) >>> 0): State {
  const s = blank(seed);
  const back: PT[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let f = 0; f < 8; f++) {
    for (const [c, r1, r2] of [['w', 0, 1], ['b', 7, 6]] as const) {
      s.board[r1 * 8 + f] = { t: back[f], c, id: s.nextId++ };
      s.board[r2 * 8 + f] = { t: 'p', c, id: s.nextId++ };
    }
  }
  s.castle = { w: { k: true, q: true }, b: { k: true, q: true } };
  s.decks.w = shuffle(s, [...SPELL_IDS]);
  s.decks.b = shuffle(s, [...SPELL_IDS]);
  beginTurn(s);
  return s;
}

/**
 * A position from 8 rows (rank 8 first); letters are pieces (upper case is
 * white), '.' is empty. For tests and tools. Castling, hands and so on are
 * given in `o`; by default nothing is castable and hands are empty.
 */
export function fromBoard(rows: string[], o: { turn?: Color; castle?: string; hands?: Partial<Record<Color, SpellId[]>>; seed?: number; ep?: string; lost?: Partial<Record<Color, number>> } = {}): State {
  const s = blank(o.seed ?? 1);
  rows.forEach((row, y) => {
    const cells = row.replace(/\s/g, '');
    for (let f = 0; f < 8; f++) {
      const ch = cells[f];
      if (!ch || ch === '.') continue;
      const c: Color = ch === ch.toUpperCase() ? 'w' : 'b';
      s.board[(7 - y) * 8 + f] = { t: ch.toLowerCase() as PT, c, id: s.nextId++ };
    }
  });
  s.turn = o.turn ?? 'w';
  for (const ch of o.castle ?? '') {
    const c: Color = ch === ch.toUpperCase() ? 'w' : 'b';
    s.castle[c][ch.toLowerCase() as 'k' | 'q'] = true;
  }
  s.hands.w = [...(o.hands?.w ?? [])];
  s.hands.b = [...(o.hands?.b ?? [])];
  s.decks.w = shuffle(s, SPELL_IDS.filter((x) => !s.hands.w.includes(x)));
  s.decks.b = shuffle(s, SPELL_IDS.filter((x) => !s.hands.b.includes(x)));
  if (o.ep) s.ep = sqIdx(o.ep);
  s.lost = { w: o.lost?.w ?? 0, b: o.lost?.b ?? 0 };
  beginTurn(s);
  return s;
}

export function clone(s: State): State {
  return {
    ...s,
    board: s.board.slice(),
    castle: { w: { ...s.castle.w }, b: { ...s.castle.b } },
    decks: { w: s.decks.w.slice(), b: s.decks.b.slice() },
    hands: { w: s.hands.w.slice(), b: s.hands.b.slice() },
    lost: { ...s.lost },
    fx: {
      frost: s.fx.frost.slice(), walls: s.fx.walls.slice(), aegis: s.fx.aegis.slice(), traps: s.fx.traps.slice(),
      phantoms: s.fx.phantoms.slice(), alarm: s.fx.alarm.slice(), silence: s.fx.silence.slice(),
    },
    lastCast: { ...s.lastCast },
    last: { ...s.last },
    flags: { ...s.flags },
  };
}

/** Everything repetition cares about, durations relative to now. */
function repKey(s: State): string {
  const b = s.board.map((p) => (p ? `${p.c}${p.t}${p.ghost ? 'g' : ''}` : '.')).join('');
  const rel = (u: number) => u - s.ply;
  const fx = [
    s.fx.frost.map((f) => `f${f.by}${f.ids.map((id) => s.board.findIndex((p) => p?.id === id)).join(',')}:${rel(f.until)}`),
    s.fx.walls.map((w) => `w${w.a}.${w.b}:${rel(w.until)}`),
    s.fx.aegis.map((a) => `a${s.board.findIndex((p) => p?.id === a.id)}:${rel(a.until)}`),
    s.fx.traps.map((t) => `t${t.by}${t.sq}.${t.sq2 ?? ''}:${rel(t.until)}`),
    s.fx.phantoms.map((p) => `p${p.by}${rel(p.until)}`),
    s.fx.alarm.map((a) => `r${a.on}:${rel(a.until)}`),
    s.fx.silence.map((x) => `s${x.on}:${rel(x.until)}`),
  ].flat().join(';');
  const hands = `${[...s.hands.w].sort().join()}|${[...s.hands.b].sort().join()}`;
  return `${b} ${s.turn} ${+s.castle.w.k}${+s.castle.w.q}${+s.castle.b.k}${+s.castle.b.q} ${s.ep} ${fx} ${hands} ${s.lost.w}${s.lost.b}`;
}

// ---------- board queries ----------

export function isWall(s: State, i: number): boolean {
  for (const w of s.fx.walls) if (w.a === i || w.b === i) return true;
  return false;
}
const empty = (s: State, i: number) => !s.board[i] && !isWall(s, i);
const aegisOn = (s: State, id: number) => s.fx.aegis.some((a) => a.id === id);
const frozen = (s: State, p: Piece) => s.fx.frost.some((f) => f.by !== p.c && f.ids.includes(p.id));
const capturable = (s: State, p: Cell, by: Color): p is Piece => !!p && p.c !== by && p.t !== 'k' && !aegisOn(s, p.id);

export function findKing(board: Cell[], c: Color): number {
  for (let i = 0; i < 64; i++) { const p = board[i]; if (p && p.t === 'k' && p.c === c) return i; }
  return -1;
}

function attacked(s: State, board: Cell[], sq: number, by: Color): boolean {
  const f = fileOf(sq), r = rankOf(sq);
  const pr = r - dirOf(by);
  for (const df of [-1, 1]) if (inB(f + df, pr)) { const p = board[pr * 8 + f + df]; if (p && p.c === by && p.t === 'p') return true; }
  for (const [df, dr] of KN) if (inB(f + df, r + dr)) { const p = board[(r + dr) * 8 + f + df]; if (p && p.c === by && p.t === 'n') return true; }
  for (const [df, dr] of ALL8) if (inB(f + df, r + dr)) { const p = board[(r + dr) * 8 + f + df]; if (p && p.c === by && p.t === 'k') return true; }
  for (const [dirs, kind] of [[ORTH, 'r'], [DIAG, 'b']] as const) {
    for (const [df, dr] of dirs) {
      let x = f + df, y = r + dr;
      while (inB(x, y)) {
        const i = y * 8 + x;
        if (isWall(s, i)) break;
        const p = board[i];
        if (p) { if (p.c === by && (p.t === 'q' || p.t === kind)) return true; break; }
        x += df; y += dr;
      }
    }
  }
  return false;
}

export function inCheck(s: State, c: Color): boolean {
  const k = findKing(s.board, c);
  return k >= 0 && attacked(s, s.board, k, other(c));
}

// ---------- move generation ----------

function trapAt(s: State, sq: number, mover: Piece) {
  if (mover.t === 'k' || aegisOn(s, mover.id)) return undefined;
  return s.fx.traps.find((t) => (t.sq === sq || t.sq2 === sq) && t.by !== mover.c);
}

function boardAfter(s: State, m: Move): Cell[] {
  const nb = s.board.slice();
  const p = nb[m.from]!;
  nb[m.from] = null;
  if (m.kind === 'ep') nb[m.to - 8 * dirOf(p.c)] = null;
  const moved: Piece = m.promo ? { t: m.promo, c: p.c, id: p.id } : p;
  nb[m.to] = moved;
  if (m.kind === 'castle') {
    if (m.to > m.from) { nb[m.from + 1] = nb[m.from + 3]; nb[m.from + 3] = null; }
    else { nb[m.from - 1] = nb[m.from - 4]; nb[m.from - 4] = null; }
  }
  if (trapAt(s, m.to, moved)) nb[m.to] = null;
  if (m.kind === 'castle') { const r = (m.from + m.to) / 2; if (trapAt(s, r, nb[r]!)) nb[r] = null; }
  return nb;
}

function legalFor(s: State, m: Move): boolean {
  const c = s.board[m.from]!.c;
  const nb = boardAfter(s, m);
  const k = findKing(nb, c);
  return k < 0 || !attacked(s, nb, k, other(c));
}

function pseudo(s: State, color: Color, kingOnly = false): Move[] {
  const out: Move[] = [];
  const own = color === s.turn;
  const leap = own && s.flags.leap;
  const ghostFresh = (p: Piece) => s.fx.phantoms.some((g) => g.id === p.id && g.placed === s.ply);
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (!p || p.c !== color) continue;
    if (kingOnly && p.t !== 'k') continue;
    if (own && (frozen(s, p) || s.flags.blinked === p.id || ghostFresh(p))) continue;
    const f = fileOf(i), r = rankOf(i);
    const push = (to: number, kind: Move['kind'], jump = false) => {
      const last = (rankOf(to) === 7 && color === 'w') || (rankOf(to) === 0 && color === 'b');
      if (p.t === 'p' && last) for (const promo of ['q', 'r', 'b', 'n'] as const) out.push({ from: i, to, kind, promo });
      else out.push(jump ? { from: i, to, kind, jump } : { from: i, to, kind });
    };
    if (p.t === 'p') {
      const d = dirOf(color), start = color === 'w' ? 1 : 6;
      const one = i + 8 * d;
      if (inB(f, r + d) && empty(s, one)) {
        push(one, 'n');
        const two = i + 16 * d;
        if (r === start && empty(s, two)) out.push({ from: i, to: two, kind: 'dbl' });
      }
      for (const df of [-1, 1]) {
        if (!inB(f + df, r + d)) continue;
        const to = (r + d) * 8 + f + df;
        if (capturable(s, s.board[to], color)) push(to, 'cap');
        else if (to === s.ep && !s.board[to]) {
          const victim = s.board[to - 8 * d];
          if (victim && victim.t === 'p' && victim.c !== color && !aegisOn(s, victim.id) && !isWall(s, to)) out.push({ from: i, to, kind: 'ep' });
        }
      }
    } else if (p.t === 'n' || p.t === 'k') {
      for (const [df, dr] of p.t === 'n' ? KN : ALL8) {
        if (!inB(f + df, r + dr)) continue;
        const to = (r + dr) * 8 + f + df;
        if (isWall(s, to)) continue;
        const t = s.board[to];
        if (!t) push(to, 'n');
        else if (capturable(s, t, color)) push(to, 'cap');
      }
      if (p.t === 'k' && !kingOnly) castling(s, color, i, out);
    } else {
      const dirs = p.t === 'r' ? ORTH : p.t === 'b' ? DIAG : ALL8;
      const canLeap = leap && (p.t === 'r' || p.t === 'b');
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr, jumped = false;
        while (inB(x, y)) {
          const to = y * 8 + x;
          if (isWall(s, to)) break;
          const t = s.board[to];
          if (!t) push(to, 'n', jumped);
          else if (capturable(s, t, color)) { push(to, 'cap', jumped); break; }
          else {
            if (!canLeap || jumped) break;
            jumped = true;
          }
          x += df; y += dr;
        }
      }
    }
  }
  return out;
}

function castling(s: State, color: Color, ksq: number, out: Move[]): void {
  const home = color === 'w' ? 4 : 60;
  if (ksq !== home) return;
  const rights = s.castle[color];
  const enemy = other(color);
  const rookAt = (i: number) => { const p = s.board[i]; return !!p && p.t === 'r' && p.c === color; };
  const safe = (i: number) => !attacked(s, s.board, i, enemy);
  if (!rights.k && !rights.q) return;
  if (!safe(home)) return;
  if (rights.k && rookAt(home + 3) && empty(s, home + 1) && empty(s, home + 2) && safe(home + 1) && safe(home + 2)) out.push({ from: home, to: home + 2, kind: 'castle' });
  if (rights.q && rookAt(home - 4) && empty(s, home - 1) && empty(s, home - 2) && empty(s, home - 3) && safe(home - 1) && safe(home - 2)) out.push({ from: home, to: home - 2, kind: 'castle' });
}

/** Legal king steps (never castling) for a colour, ignoring Royal Alarm. */
function kingMoves(s: State, color: Color): Move[] {
  return pseudo(s, color, true).filter((m) => legalFor(s, m));
}

const alarmForced = (s: State, c: Color) => s.fx.alarm.some((a) => a.on === c && a.forced);

/** The legal moves for the side to move, with every effect applied. */
export function legalMoves(s: State): Move[] {
  if (s.result || s.pending || s.flags.moved) return [];
  let moves = pseudo(s, s.turn).filter((m) => legalFor(s, m));
  // Royal Alarm: the king must move, or a piece that is under attack may get away.
  if (alarmForced(s, s.turn)) {
    const foe = other(s.turn);
    moves = moves.filter((m) => m.kind !== 'castle' && (s.board[m.from]!.t === 'k' || attacked(s, s.board, m.from, foe)));
  }
  return moves;
}

// ---------- card drawing ----------

function drawCard(s: State, c: Color): SpellId | null {
  if (!s.decks[c].length) s.decks[c] = shuffle(s, SPELL_IDS.filter((x) => !s.hands[c].includes(x)));
  const card = s.decks[c].shift();
  if (!card) return null;
  s.hands[c].push(card);
  if (s.hands[c].length > HAND_LIMIT) s.pending = { color: c };
  return card;
}

// ---------- moves ----------

function leaveSquare(s: State, i: number): void {
  if (i === 0) s.castle.w.q = false;
  else if (i === 7) s.castle.w.k = false;
  else if (i === 56) s.castle.b.q = false;
  else if (i === 63) s.castle.b.k = false;
  else if (i === 4) s.castle.w = { k: false, q: false };
  else if (i === 60) s.castle.b = { k: false, q: false };
}

function dropGhost(s: State, id: number): void {
  s.fx.phantoms = s.fx.phantoms.filter((g) => g.id !== id);
}

/** Remove a piece that a trap or spell destroyed. */
function destroy(s: State, sq: number): void {
  const p = s.board[sq];
  if (!p) return;
  s.board[sq] = null;
  if (p.ghost) dropGhost(s, p.id);
  else if (p.t === 'p') s.lost[p.c]++;
}

/** A piece has arrived on `sq` by a move or a spell: an enemy trap goes off. */
function landed(s: State, sq: number): boolean {
  const p = s.board[sq];
  if (!p) return false;
  const trap = trapAt(s, sq, p);
  if (!trap) return false;
  s.fx.traps = s.fx.traps.filter((t) => t !== trap);
  destroy(s, sq);
  s.half = 0;
  return true;
}

/**
 * Make a move. Draws a card on a capture. Ends the turn on its own if a spell
 * was already cast or no castable spell remains; otherwise the player may cast
 * (state.flags.moved && !cast) or call endTurn. `quick` skips that choice and
 * auto-discards, for the bot's search.
 */
export function applyMove(s0: State, m: Move, quick = false): State {
  const s = clone(s0);
  const p = s.board[m.from]!;
  const color = p.c;
  let captured: Piece | null = null;
  s.board[m.from] = null;
  if (m.kind === 'ep') { const sq = m.to - 8 * dirOf(color); captured = s.board[sq]; s.board[sq] = null; }
  else if (m.kind === 'cap') captured = s.board[m.to];
  const moved: Piece = m.promo ? { t: m.promo, c: color, id: p.id } : p;
  s.board[m.to] = moved;
  if (m.kind === 'castle') {
    if (m.to > m.from) { s.board[m.from + 1] = s.board[m.from + 3]; s.board[m.from + 3] = null; }
    else { s.board[m.from - 1] = s.board[m.from - 4]; s.board[m.from - 4] = null; }
  }
  leaveSquare(s, m.from);
  leaveSquare(s, m.to);
  if (captured) {
    if (captured.ghost) dropGhost(s, captured.id);
    else if (captured.t === 'p') s.lost[captured.c]++;
  }
  s.half = p.t === 'p' || captured ? 0 : s.half + 1;
  s.ep = -1;
  if (m.kind === 'dbl') {
    const mid = (m.from + m.to) / 2;
    const f = fileOf(m.to);
    const adj = [f - 1, f + 1].some((x) => inB(x, rankOf(m.to)) && s.board[rankOf(m.to) * 8 + x]?.t === 'p' && s.board[rankOf(m.to) * 8 + x]!.c !== color);
    if (adj) s.ep = mid;
  }
  landed(s, m.to);
  if (m.kind === 'castle') landed(s, (m.from + m.to) / 2);
  const survives = !!s.board[m.to];
  s.last[color] = { by: color, from: m.from, to: m.to, id: p.id, plain: (m.kind === 'n' || m.kind === 'dbl') && p.t !== 'k' && !m.promo && survives };
  s.flags.moved = true;
  s.flags.leap = false;
  if (captured && !captured.ghost) drawCard(s, color);
  if (quick && s.pending) discard(s, s.hands[color][0], true);
  return settle(s, quick);
}

/** Resolve the discard when a 4th card was drawn. */
export function discard(s0: State, spell: SpellId, inPlace = false): State {
  const s = inPlace ? s0 : clone(s0);
  if (!s.pending) throw new Error('nothing to discard');
  const hand = s.hands[s.pending.color];
  const i = hand.indexOf(spell);
  if (i < 0) throw new Error('card not in hand');
  hand.splice(i, 1);
  s.pending = null;
  return inPlace ? s : settle(s, false);
}

export function endTurn(s0: State, quick = false): State {
  const s = clone(s0);
  if (!s.flags.moved || s.pending) throw new Error('cannot end the turn yet');
  return advance(s, quick);
}

/** After an action: end the turn if it is over, otherwise leave the choice. */
function settle(s: State, quick: boolean): State {
  if (s.result || s.pending || !s.flags.moved) return s;
  if (quick || s.flags.cast || legalCasts(s, true).length === 0) return advance(s, quick);
  return s;
}

function advance(s: State, quick = false): State {
  s.ply++;
  s.turn = other(s.turn);
  if (s.turn === 'w') s.full++;
  s.flags = { cast: false, moved: false, leap: false, blinked: null };
  const live = <T extends { until: number }>(a: T[]) => a.filter((e) => e.until > s.ply);
  for (const g of s.fx.phantoms) if (g.until <= s.ply) { const i = s.board.findIndex((p) => p?.id === g.id); if (i >= 0) s.board[i] = null; }
  s.fx = {
    frost: live(s.fx.frost), walls: live(s.fx.walls), aegis: live(s.fx.aegis), traps: live(s.fx.traps),
    phantoms: live(s.fx.phantoms), alarm: live(s.fx.alarm), silence: live(s.fx.silence),
  };
  beginTurn(s, quick);
  return s;
}

/** Start-of-turn bookkeeping: Royal Alarm, repetition, and the end of the game. */
function beginTurn(s: State, quick = false): void {
  if (s.fx.alarm.length) s.fx.alarm = s.fx.alarm.map((a) => (a.on === s.turn ? { ...a, forced: kingMoves(s, s.turn).length > 0 } : a));
  // The bot's search skips the rest and spots the end of the game itself.
  if (quick) return;
  s.reps = { ...s.reps };
  const key = repKey(s);
  s.reps[key] = (s.reps[key] ?? 0) + 1;
  if (s.reps[key] >= 3) { s.result = { winner: null, reason: 'repetition' }; return; }
  if (s.half >= 100) { s.result = { winner: null, reason: 'fifty-move rule' }; return; }
  if (!hasAction(s)) {
    s.result = inCheck(s, s.turn) ? { winner: other(s.turn), reason: 'checkmate' } : { winner: null, reason: 'stalemate' };
  }
}

/** A legal move, or a legal spell that leaves a legal move. */
function hasAction(s: State): boolean {
  return legalMoves(s).length > 0 || legalCasts(s, true).length > 0;
}

// ---------- spells ----------

const silenced = (s: State, c: Color) => s.fx.silence.some((x) => x.on === c);

const squares = (pred: (i: number) => boolean) => { const o: number[] = []; for (let i = 0; i < 64; i++) if (pred(i)) o.push(i); return o; };

/** Raw target lists to try for a spell; tryCast decides which are legal. */
function candidates(s: State, spell: SpellId, c: Color): number[][] {
  const e = other(c);
  const mine = (pred: (p: Piece) => boolean) => squares((i) => { const p = s.board[i]; return !!p && p.c === c && !p.ghost && pred(p); });
  const one = (xs: number[]) => xs.map((x) => [x]);
  switch (spell) {
    case 'frost': return one(squares((i) => fileOf(i) <= 6 && rankOf(i) <= 6));
    case 'phantom': return one(squares((i) => empty(s, i) && (c === 'w' ? rankOf(i) <= 3 : rankOf(i) >= 4)));
    case 'alarm': case 'timeslip': case 'leap': case 'silence': return [[]];
    case 'transpose': {
      const xs = mine((p) => p.t !== 'k');
      return xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b]));
    }
    case 'blink': return mine((p) => p.t === 'n' || p.t === 'b' || p.t === 'r').flatMap((from) =>
      squares((to) => empty(s, to) && Math.max(Math.abs(fileOf(to) - fileOf(from)), Math.abs(rankOf(to) - rankOf(from))) <= 2).map((to) => [from, to]));
    case 'wall': case 'trap': return squares((i) => empty(s, i)).flatMap((a) => {
      const o: number[][] = [];
      if (fileOf(a) < 7 && empty(s, a + 1)) o.push([a, a + 1]);
      if (rankOf(a) < 7 && empty(s, a + 8)) o.push([a, a + 8]);
      return o;
    });
    case 'aegis': return one(mine((p) => p.t !== 'k'));
    case 'surge': return one(mine((p) => p.t === 'p'));
    case 'shapeshift': return one(mine((p) => p.t === 'n' || p.t === 'b'));
    case 'revive': return one(squares((i) => empty(s, i) && rankOf(i) === (c === 'w' ? 1 : 6)));
    case 'smite': case 'charm': return one(squares((i) => s.board[i]?.c === e && s.board[i]!.t === 'p'));
    case 'gust': return squares((i) => s.board[i]?.c === e && s.board[i]!.t !== 'k').flatMap((from) =>
      ALL8.filter(([df, dr]) => inB(fileOf(from) + df, rankOf(from) + dr)).map(([df, dr]) => [from, from + df + dr * 8]));
    default: return [];
  }
}

/** Apply a spell's effect to a clone. False if the targets are illegal. */
function resolve(s: State, spell: SpellId, at: number[], c: Color): boolean {
  const e = other(c);
  const P = s.ply;
  const own = (i: number | undefined): Piece | null => { const p = i === undefined ? null : s.board[i]; return p && p.c === c && !p.ghost ? p : null; };
  const lastRank = (to: number, col: Color) => rankOf(to) === (col === 'w' ? 7 : 0);
  const backRank = (to: number) => rankOf(to) === 0 || rankOf(to) === 7;
  const move = (from: number, to: number) => { s.board[to] = s.board[from]; s.board[from] = null; leaveSquare(s, from); landed(s, to); };

  switch (spell) {
    case 'frost': {
      const o = at[0];
      if (at.length !== 1 || o === undefined || fileOf(o) > 6 || rankOf(o) > 6) return false;
      const ids = [o, o + 1, o + 8, o + 9].map((i) => s.board[i]).filter((p): p is Piece => !!p && p.c === e && p.t !== 'k').map((p) => p.id);
      if (!ids.length) return false;
      s.fx.frost.push({ by: c, ids, until: P + 2 });
      return true;
    }
    case 'phantom': {
      const sq = at[0];
      if (at.length !== 1 || sq === undefined || s.fx.phantoms.some((g) => g.by === c)) return false;
      if (!empty(s, sq) || (c === 'w' ? rankOf(sq) > 3 : rankOf(sq) < 4)) return false;
      const ek = findKing(s.board, e);
      if (ek >= 0 && KN.some(([df, dr]) => inB(fileOf(sq) + df, rankOf(sq) + dr) && (rankOf(sq) + dr) * 8 + fileOf(sq) + df === ek)) return false;
      const id = s.nextId++;
      s.board[sq] = { t: 'n', c, id, ghost: true };
      s.fx.phantoms.push({ by: c, id, placed: P, until: P + 7 });
      landed(s, sq);
      return true;
    }
    case 'alarm': {
      if (kingMoves(s, e).length === 0) return false;
      s.fx.alarm = s.fx.alarm.filter((a) => a.on !== e);
      s.fx.alarm.push({ by: c, on: e, until: P + 2, forced: false });
      return true;
    }
    case 'transpose': {
      const [a, b] = at;
      const pa = own(a), pb = own(b);
      if (at.length !== 2 || a === b || !pa || !pb || pa.t === 'k' || pb.t === 'k' || frozen(s, pa) || frozen(s, pb)) return false;
      if ((pa.t === 'p' && backRank(b)) || (pb.t === 'p' && backRank(a))) return false;
      s.board[a] = pb; s.board[b] = pa;
      leaveSquare(s, a); leaveSquare(s, b);
      landed(s, a); landed(s, b);
      return true;
    }
    case 'blink': {
      const [from, to] = at;
      const p = own(from);
      if (at.length !== 2 || !p || (p.t !== 'n' && p.t !== 'b' && p.t !== 'r') || frozen(s, p) || !empty(s, to)) return false;
      const d = Math.max(Math.abs(fileOf(to) - fileOf(from)), Math.abs(rankOf(to) - rankOf(from)));
      if (d < 1 || d > 2) return false;
      move(from, to);
      s.flags.blinked = p.id;
      return true;
    }
    case 'wall': {
      const [a, b] = at;
      if (at.length !== 2 || a === undefined || b === undefined || !empty(s, a) || !empty(s, b)) return false;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (!(hi - lo === 8 || (hi - lo === 1 && rankOf(lo) === rankOf(hi)))) return false;
      s.fx.walls.push({ by: c, a: lo, b: hi, until: P + 4 });
      return true;
    }
    case 'aegis': {
      const p = own(at[0]);
      if (at.length !== 1 || !p || p.t === 'k') return false;
      s.fx.aegis = s.fx.aegis.filter((x) => x.id !== p.id);
      s.fx.aegis.push({ by: c, id: p.id, until: P + 2 });
      return true;
    }
    case 'surge': {
      const from = at[0];
      const p = own(from);
      if (at.length !== 1 || from === undefined || !p || p.t !== 'p' || frozen(s, p)) return false;
      const to = from + 8 * dirOf(c);
      if (to < 0 || to > 63 || !empty(s, to) || lastRank(to, c)) return false;
      move(from, to);
      return true;
    }
    case 'shapeshift': {
      const sq = at[0];
      const p = own(sq);
      if (at.length !== 1 || sq === undefined || !p || (p.t !== 'n' && p.t !== 'b')) return false;
      s.board[sq] = { t: p.t === 'n' ? 'b' : 'n', c, id: p.id };
      return true;
    }
    case 'revive': {
      const sq = at[0];
      if (at.length !== 1 || sq === undefined || s.lost[c] < 1 || rankOf(sq) !== (c === 'w' ? 1 : 6) || !empty(s, sq)) return false;
      s.board[sq] = { t: 'p', c, id: s.nextId++ };
      s.lost[c]--;
      landed(s, sq);
      return true;
    }
    case 'gust': {
      const [from, to] = at;
      const p = from === undefined ? null : s.board[from];
      if (at.length !== 2 || from === undefined || to === undefined || !p || p.c !== e || p.t === 'k') return false;
      const df = fileOf(to) - fileOf(from), dr = rankOf(to) - rankOf(from);
      if (Math.abs(df) > 1 || Math.abs(dr) > 1 || (df === 0 && dr === 0)) return false;
      const sx = fileOf(from) - df, sy = rankOf(from) - dr;
      if (!inB(sx, sy)) return false;
      const pusher = s.board[sy * 8 + sx];
      if (!pusher || pusher.c !== c) return false;
      if (!empty(s, to) || (p.t === 'p' && backRank(to))) return false;
      move(from, to);
      return true;
    }
    case 'timeslip': {
      const l = s.last[e];
      if (!l || !l.plain) return false;
      const p = s.board[l.to];
      if (!p || p.id !== l.id || p.c !== e || !empty(s, l.from)) return false;
      s.board[l.from] = p; s.board[l.to] = null;
      s.ep = -1;
      s.last[e] = null;
      landed(s, l.from);
      return true;
    }
    case 'trap': {
      // Two adjacent squares. One square is still accepted, for games recorded before the trap grew.
      const [a, b] = at;
      if (at.length < 1 || a === undefined || !empty(s, a) || s.fx.traps.some((t) => t.by === c)) return false;
      if (b === undefined) { s.fx.traps.push({ by: c, sq: a, until: P + 7 }); return true; }
      if (!empty(s, b)) return false;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (!(hi - lo === 8 || (hi - lo === 1 && rankOf(lo) === rankOf(hi)))) return false;
      s.fx.traps.push({ by: c, sq: lo, sq2: hi, until: P + 7 });
      return true;
    }
    case 'smite': {
      const sq = at[0];
      const p = sq === undefined ? null : s.board[sq];
      if (at.length !== 1 || sq === undefined || !p || p.c !== e || p.t !== 'p' || aegisOn(s, p.id)) return false;
      const f = fileOf(sq), r = rankOf(sq);
      if (!ALL8.some(([df, dr]) => inB(f + df, r + dr) && s.board[(r + dr) * 8 + f + df]?.c === c)) return false;
      destroy(s, sq);
      s.half = 0;
      return true;
    }
    case 'leap': s.flags.leap = true; return true;
    case 'charm': {
      const from = at[0];
      const p = from === undefined ? null : s.board[from];
      if (at.length !== 1 || from === undefined || !p || p.c !== e || p.t !== 'p') return false;
      const to = from + 8 * dirOf(e);
      if (to < 0 || to > 63 || !empty(s, to) || lastRank(to, e)) return false;
      move(from, to);
      return true;
    }
    case 'silence': {
      s.fx.silence.push({ on: e, until: P + 2 });
      s.fx.frost = s.fx.frost.filter((x) => x.by !== e);
      s.fx.walls = s.fx.walls.filter((x) => x.by !== e);
      s.fx.aegis = s.fx.aegis.filter((x) => x.by !== e);
      s.fx.traps = s.fx.traps.filter((x) => x.by !== e);
      s.fx.alarm = s.fx.alarm.filter((x) => x.by !== e);
      for (const g of s.fx.phantoms.filter((x) => x.by === e)) { const i = s.board.findIndex((p) => p?.id === g.id); if (i >= 0) s.board[i] = null; }
      s.fx.phantoms = s.fx.phantoms.filter((x) => x.by !== e);
      return true;
    }
    default: return false;
  }
}

/** Try a cast for the side to move; the new state, or null if illegal. */
export function tryCast(s0: State, cast: Cast): State | null {
  const c = s0.turn;
  if (s0.result || s0.pending || s0.flags.cast || silenced(s0, c) || !s0.hands[c].includes(cast.spell)) return null;
  // Casts can come off the network: targets must be squares, and no more than two.
  if (!Array.isArray(cast.at) || cast.at.length > 2 || cast.at.some((i) => !Number.isInteger(i) || i < 0 || i > 63)) return null;
  const pre = !s0.flags.moved;
  let effective: SpellId = cast.spell;
  if (cast.spell === 'echo') {
    const copy = s0.lastCast[other(c)];
    if (!copy || cast.as !== copy) return null;
    effective = copy;
  } else if (cast.as) return null;
  if (effective === 'leap' && !pre) return null;
  if ((effective === 'alarm' || effective === 'timeslip' || effective === 'leap' || effective === 'silence') && cast.at.length) return null;
  const s = clone(s0);
  if (!resolve(s, effective, cast.at, c)) return null;
  s.hands[c].splice(s.hands[c].indexOf(cast.spell), 1);
  s.lastCast[c] = effective;
  s.flags.cast = true;
  const mk = findKing(s.board, c), ek = findKing(s.board, other(c));
  if (mk >= 0 && attacked(s, s.board, mk, other(c))) return null;
  if (pre) {
    if (ek >= 0 && attacked(s, s.board, ek, c)) return null;
    const moves = legalMoves(s);
    if (!moves.length) return null;
    if (effective === 'leap' && !moves.some((m) => m.jump)) return null;
  }
  return s;
}

/** Every legal cast right now (or just the first, when `first`). */
export function legalCasts(s: State, first = false): Cast[] {
  const c = s.turn;
  const out: Cast[] = [];
  if (s.result || s.pending || s.flags.cast || silenced(s, c)) return out;
  for (const card of new Set(s.hands[c])) {
    const spell: SpellId | null = card === 'echo' ? s.lastCast[other(c)] : card;
    if (!spell) continue;
    for (const at of candidates(s, spell, c)) {
      const cast: Cast = card === 'echo' ? { spell: 'echo', at, as: spell } : { spell, at };
      if (tryCast(s, cast)) { out.push(cast); if (first) return out; }
    }
  }
  return out;
}

/** Cast a spell. Ends the turn if the move is already made. */
export function applyCast(s0: State, cast: Cast, quick = false): State {
  const s = tryCast(s0, cast);
  if (!s) throw new Error(`illegal cast ${cast.spell} ${cast.at.map(sqName)}`);
  return settle(s, quick);
}

// ---------- helpers for UI, bot and tools ----------

export function phantomTurnsLeft(s: State, id: number): number {
  const g = s.fx.phantoms.find((x) => x.id === id);
  return g ? Math.min(3, Math.ceil((g.until - s.ply) / 2)) : 0;
}

export function trapTurnsLeft(s: State, sq: number): number {
  const t = s.fx.traps.find((x) => x.sq === sq || x.sq2 === sq);
  return t ? Math.min(3, Math.ceil((t.until - s.ply) / 2)) : 0;
}

export const isFrozen = (s: State, p: Piece) => frozen(s, p);
export const hasAegis = (s: State, id: number) => aegisOn(s, id);
export const alarmOn = (s: State, c: Color) => s.fx.alarm.some((a) => a.on === c && a.forced);
export const isSilenced = silenced;

/** Short coordinate notation: Ng1-f3, e4xd5, O-O. Call with the state before the move. */
export function moveText(s: State, m: Move): string {
  const p = s.board[m.from]!;
  if (m.kind === 'castle') return m.to > m.from ? 'O-O' : 'O-O-O';
  const letter = p.t === 'p' ? '' : p.t.toUpperCase();
  const x = m.kind === 'cap' || m.kind === 'ep' ? 'x' : '-';
  return `${p.ghost ? 'Ghost ' : ''}${letter}${sqName(m.from)}${x}${sqName(m.to)}${m.promo ? '=' + m.promo.toUpperCase() : ''}${m.kind === 'ep' ? ' e.p.' : ''}`;
}

/** Plain-language description of a cast, for the move log. */
export function castText(cast: Cast, names: Record<SpellId, string>): string {
  const name = names[cast.spell];
  const sq = cast.at.map(sqName);
  const spell = cast.as ?? cast.spell;
  const arrow = ['blink', 'gust', 'transpose'].includes(spell);
  const detail = sq.length ? (arrow ? `${sq[0]} → ${sq[1]}` : (spell === 'wall' || spell === 'trap') && sq.length > 1 ? `${sq[0]}–${sq[1]}` : spell === 'frost' ? `${sq[0]}–${sqName(cast.at[0] + 9)}` : sq[0]) : '';
  const via = cast.as ? ` (${names[cast.as]})` : '';
  return `${name}${via}${detail ? ': ' + detail : ''}`;
}

// ---------- god mode (secret codes) ----------
// Plain state changes, so they undo and save like everything else.

/** Fling a piece off the board. Flicking a king ends the game. */
export function godFlick(s0: State, sq: number): State {
  const s = clone(s0);
  const p = s.board[sq];
  if (!p || s.result) return s0;
  destroy(s, sq);
  s.half = 0;
  s.fx.aegis = s.fx.aegis.filter((a) => a.id !== p.id);
  if (p.t === 'k') s.result = { winner: other(p.c), reason: 'divine intervention' };
  return s;
}

/** Turn one of `c`'s pawns into a queen on the spot. */
export function godAnoint(s0: State, sq: number): State {
  const s = clone(s0);
  const p = s.board[sq];
  if (!p || p.t !== 'p' || s.result) return s0;
  s.board[sq] = { t: 'q', c: p.c, id: p.id };
  return s;
}

/** Put any spell straight into a hand (discarding when it overflows). */
export function godWish(s0: State, c: Color, spell: SpellId): State {
  const s = clone(s0);
  if (s.result || s.pending || s.hands[c].includes(spell)) return s0;
  s.decks[c] = s.decks[c].filter((x) => x !== spell);
  s.hands[c].push(spell);
  if (s.hands[c].length > HAND_LIMIT) s.pending = { color: c };
  return s;
}

/** Time stop: the side to move loses its turn. */
export function godPass(s0: State): State {
  const s = clone(s0);
  if (s.result || s.pending) return s0;
  s.flags.moved = true;
  return advance(s);
}

/** Turn an enemy piece into a pawn. Not kings, and not on a back rank. */
export function godChicken(s0: State, sq: number): State {
  const s = clone(s0);
  const p = s.board[sq];
  if (!p || p.t === 'k' || p.t === 'p' || p.ghost || rankOf(sq) === 0 || rankOf(sq) === 7 || s.result) return s0;
  s.board[sq] = { t: 'p', c: p.c, id: p.id };
  leaveSquare(s, sq);
  return s;
}
