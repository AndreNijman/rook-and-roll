// The Spell Chess bot. Stockfish does not know these rules, so this is a
// small alpha-beta search over the spell engine. Moves are searched properly;
// spells are scored "cast vs. don't cast": a shortlist of casts is tried, and
// one is played when it beats the best spell-less line by more than a card
// is worth. The bot is asked for one action at a time (cast, move, discard,
// end turn), so it needs no memory between them.

import {
  applyCast, applyMove, clone, endTurn, fileOf, inCheck, legalCasts, legalMoves, other, rankOf, tryCast,
  type Cast, type Color, type Move, type SpellId, type State,
} from './engine';

export type Action =
  | { k: 'move'; move: Move }
  | { k: 'cast'; cast: Cast }
  | { k: 'discard'; spell: SpellId }
  | { k: 'end' };

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 } as const;
const MATE = 100000;
const CARD = 22;
/** A cast must beat the spell-less line by this much on top of the card's worth. */
const MARGIN = 12;
/** With a full hand the next draw is wasted, so a card costs nothing to spend. */
const spare = (s: State, c: Color) => (s.hands[c].length >= 3 ? CARD : 0);

/** Rough worth of holding each card, for discards. */
const KEEP: Record<SpellId, number> = {
  smite: 9, revive: 8, frost: 7, aegis: 7, gust: 6, leap: 6, phantom: 6, blink: 6, timeslip: 5,
  transpose: 5, trap: 5, silence: 4, alarm: 4, wall: 4, echo: 4, surge: 3, charm: 3, shapeshift: 2,
};

/** Static score from White's side, in centipawns. */
export function evaluate(s: State): number {
  let score = 0;
  let queens = 0;
  for (let i = 0; i < 64; i++) if (s.board[i]?.t === 'q') queens++;
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (!p) continue;
    const sign = p.c === 'w' ? 1 : -1;
    const f = fileOf(i), r = p.c === 'w' ? rankOf(i) : 7 - rankOf(i);
    const centre = 3 - Math.max(Math.abs(f - 3.5), Math.abs(rankOf(i) - 3.5)) + 0.5;
    let v: number = p.ghost ? 110 : VAL[p.t];
    if (p.t === 'p') v += r * 7 + (r >= 5 ? (r - 4) * 25 : 0) + (f === 3 || f === 4 ? r * 4 : 0);
    else if (p.t === 'n' || p.t === 'b') v += centre * 9 + (r === 0 ? -12 : 0);
    else if (p.t === 'r') v += r === 6 ? 15 : 0;
    else if (p.t === 'q') v += centre * 2;
    else if (p.t === 'k') v += queens ? -r * 14 + (f < 3 || f > 5 ? 18 : 0) : centre * 10;
    score += sign * v;
  }
  score += (s.hands.w.length - s.hands.b.length) * CARD;
  return score;
}

const moveOrder = (s: State, m: Move) => (m.kind === 'cap' ? 10 * VAL[s.board[m.to]!.t] - VAL[s.board[m.from]!.t] : m.kind === 'ep' ? 900 : 0) + (m.promo === 'q' ? 8000 : 0);

function quiesce(s: State, alpha: number, beta: number, depth: number): number {
  const side = s.turn === 'w' ? 1 : -1;
  const stand = side * evaluate(s);
  if (depth === 0 || stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  const caps = legalMoves(s).filter((m) => m.kind === 'cap' || m.kind === 'ep' || m.promo === 'q').sort((a, b) => moveOrder(s, b) - moveOrder(s, a));
  for (const m of caps) {
    const v = -quiesce(applyMove(s, m, true), -beta, -alpha, depth - 1);
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

/** Negamax over moves only. Turns end at once (the engine's quick mode). */
function search(s: State, depth: number, alpha: number, beta: number, ply: number): number {
  if (s.half >= 100) return 0;
  const moves = legalMoves(s);
  if (!moves.length) return inCheck(s, s.turn) ? -MATE + ply : 0;
  if (depth <= 0) return quiesce(s, alpha, beta, 3);
  moves.sort((a, b) => moveOrder(s, b) - moveOrder(s, a));
  let best = -Infinity;
  for (const m of moves) {
    const v = -search(applyMove(s, m, true), depth - 1, -beta, -alpha, ply + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/** Best move from here for the side to move, with its score. */
function bestMove(s: State, depth: number, noise: number, rand: () => number): { move: Move | null; score: number } {
  let move: Move | null = null, score = -Infinity, alpha = -Infinity;
  const moves = legalMoves(s).sort((a, b) => moveOrder(s, b) - moveOrder(s, a));
  for (const m of moves) {
    // With noise every move needs its true score, so the window stays open.
    const v = -search(applyMove(s, m, true), depth - 1, -Infinity, noise ? Infinity : -alpha, 1) + (noise ? (rand() - 0.5) * 2 * noise : 0);
    if (v > score) { score = v; move = m; }
    if (v > alpha) alpha = v;
  }
  return { move, score };
}

const attackers = (s: State, sq: number, by: Color): boolean => {
  // Is `sq` a destination of some capture for `by`? Cheap enough for a shortlist.
  const probe = clone(s);
  probe.turn = by;
  probe.flags = { cast: false, moved: false, leap: false, blinked: null };
  return legalMoves(probe).some((m) => m.to === sq && m.kind === 'cap');
};

const reachCache = new WeakMap<State, Map<number, number>>();
/** How many moves of `foe`'s pieces (not the king) end on each square, worked out once per position. */
function foeReach(s: State, foe: Color): Map<number, number> {
  let reach = reachCache.get(s);
  if (!reach) {
    reach = new Map();
    const probe = clone(s);
    probe.turn = foe;
    probe.flags = { cast: false, moved: false, leap: false, blinked: null };
    for (const m of legalMoves(probe)) if (probe.board[m.from]!.t !== 'k') reach.set(m.to, (reach.get(m.to) ?? 0) + 1);
    reachCache.set(s, reach);
  }
  return reach;
}

/** What static evaluation cannot see about a cast, in centipawns. */
function hunch(s: State, after: State, cast: Cast, me: Color): number {
  const spell = cast.as ?? cast.spell;
  const foe = other(me);
  switch (spell) {
    case 'frost': {
      const frost = after.fx.frost[after.fx.frost.length - 1];
      let v = 0;
      for (const id of frost.ids) {
        const sq = s.board.findIndex((p) => p?.id === id);
        const p = s.board[sq]!;
        v += VAL[p.t] * (attackers(s, sq, me) ? 0.35 : 0.03);
      }
      return v;
    }
    case 'aegis': {
      const sq = cast.at[0];
      return attackers(s, sq, foe) ? VAL[s.board[sq]!.t] * 0.3 : -20;
    }
    case 'silence': return (s.fx.walls.concat(s.fx.traps as never[], s.fx.aegis as never[], s.fx.frost as never[]) as { by: Color }[]).filter((x) => x.by === foe).length * 40 + s.hands[foe].length * 6 - 10;
    case 'phantom': return 45;
    case 'leap': return 30;
    case 'trap': {
      // Worth more the more enemy moves it takes away.
      const reach = foeReach(s, foe);
      return 6 + 7 * cast.at.reduce((n, sq) => n + (reach.get(sq) ?? 0), 0);
    }
    case 'alarm': return 8;
    case 'wall': return 4;
    default: return 0;
  }
}

/** The most promising casts: a few per spell, ranked by a static look. */
function shortlist(s: State, casts: Cast[], limit: number, perSpell: number): Cast[] {
  const me = s.turn, sign = me === 'w' ? 1 : -1;
  const base = sign * evaluate(s);
  const scored = casts.map((cast) => {
    const after = tryCast(s, cast)!;
    return { cast, v: sign * evaluate(after) - base + CARD + hunch(s, after, cast, me) };
  }).sort((a, b) => b.v - a.v);
  const count = new Map<string, number>();
  const out: Cast[] = [];
  for (const { cast } of scored) {
    const key = cast.as ?? cast.spell;
    const n = count.get(key) ?? 0;
    if (n >= perSpell) continue;
    count.set(key, n + 1);
    out.push(cast);
    if (out.length >= limit) break;
  }
  return out;
}

export interface Level { depth: number; noise: number; casts: number }
export const LEVELS: Level[] = [
  { depth: 1, noise: 90, casts: 5 },
  { depth: 2, noise: 25, casts: 8 },
  { depth: 3, noise: 0, casts: 10 },
];

/** The bot's next action for the side to move. */
export function botAction(s: State, level: Level, rand: () => number = Math.random, note?: (cast: Cast, gain: number) => void): Action {
  const me = s.pending?.color ?? s.turn;
  if (s.pending) {
    const hand = s.hands[me];
    return { k: 'discard', spell: hand.reduce((a, b) => (KEEP[b] < KEEP[a] ? b : a)) };
  }
  // Spell lines are searched one ply shallower than plain moves, and compared
  // with plain moves at that same depth so the comparison is fair.
  const shallow = Math.max(1, level.depth - 1);

  if (s.flags.moved) {
    // After the move: cast now, or keep the card.
    const idle = endScore(endTurn(s, true), shallow);
    let best: Cast | null = null, top = idle + MARGIN;
    for (const cast of shortlist(s, legalCasts(s), level.casts, 2)) {
      // The hand is one card lighter after the cast, which evaluate() counts.
      const v = endScore(applyCast(s, cast, true), shallow) + spare(s, me);
      if (v > top) { top = v; best = cast; }
    }
    if (best) note?.(best, top - idle);
    return best ? { k: 'cast', cast: best } : { k: 'end' };
  }

  const plain = bestMove(s, level.depth, level.noise, rand);
  if (s.flags.cast) return plain.move ? { k: 'move', move: plain.move } : { k: 'end' };

  const casts = legalCasts(s);
  if (!plain.move) {
    // No legal move: a spell is the only way on (check or stalemate escape).
    let best: Cast | null = null, top = -Infinity;
    for (const cast of shortlist(s, casts, 30, 6)) {
      const v = bestMove(tryCast(s, cast)!, shallow, 0, rand).score;
      if (v > top) { top = v; best = cast; }
    }
    return best ? { k: 'cast', cast: best } : { k: 'end' };
  }
  if (casts.length) {
    const without = level.depth === shallow && !level.noise ? plain.score : bestMove(s, shallow, 0, rand).score;
    let best: Cast | null = null, top = without + MARGIN;
    for (const cast of shortlist(s, casts, level.casts, 2)) {
      const v = bestMove(tryCast(s, cast)!, shallow, 0, rand).score + spare(s, me);
      if (v > top) { top = v; best = cast; }
    }
    if (best && rand() * 100 >= level.noise * 0.4) { note?.(best, top - without); return { k: 'cast', cast: best }; }
  }
  return { k: 'move', move: plain.move };
}

/** Score for the player who just finished the turn that led to `next`. */
function endScore(next: State, depth: number): number {
  return -search(next, depth, -Infinity, Infinity, 1);
}
