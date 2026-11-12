// A Spell Chess game as a seed plus the list of actions taken. Replaying the
// list rebuilds the exact state (the shuffles come from the seed), which gives
// takebacks, the saved game and the move log from one small record, and is
// what an online relay would pass around.

import {
  applyCast, applyMove, castText, discard, endTurn, godAnoint, godChicken, godFlick, godPass, godWish, inCheck,
  legalMoves, moveText, newGame, other, sqName, tryCast,
  type Cast, type Color, type SpellId, type State,
} from './engine';
import { SPELL_NAMES } from './spells';

export type Act =
  | { k: 'm'; from: number; to: number; promo?: 'q' | 'r' | 'b' | 'n' }
  | { k: 'c'; cast: Cast }
  | { k: 'd'; spell: SpellId }
  | { k: 'e' }
  | { k: 'g'; p: 'flick' | 'anoint' | 'chicken'; sq: number }
  | { k: 'g'; p: 'wish'; spell: SpellId; c: Color }
  | { k: 'g'; p: 'pass' | 'swap' };

export interface LogLine { text: string; kind: 'move' | 'spell' | 'note' | 'god'; by: Color }

export interface Game {
  state: State;
  log: LogLine[];
  /** Squares of the last move or spell, for the board highlight. */
  mark: number[];
  /** How many times the god power "swap sides" was used. */
  swaps: number;
}

const NAME: Record<Color, string> = { w: 'White', b: 'Black' };
const PIECE: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function startGame(seed: number): Game {
  return { state: newGame(seed), log: [], mark: [], swaps: 0 };
}

/** Card draws and discards show up as hand changes. */
function handNotes(before: State, after: State, log: LogLine[]): void {
  for (const c of ['w', 'b'] as const) {
    for (const card of after.hands[c]) if (!before.hands[c].includes(card)) log.push({ text: `${NAME[c]} draws ${SPELL_NAMES[card]}.`, kind: 'note', by: c });
  }
}

function ending(s: State, log: LogLine[]): void {
  if (!s.result) return;
  log.push({ text: s.result.winner ? `${NAME[s.result.winner]} wins by ${s.result.reason}.` : `Draw by ${s.result.reason}.`, kind: 'note', by: s.result.winner ?? 'w' });
}

/** Apply one action. Returns null if it is not legal here. */
export function act(g: Game, a: Act): Game | null {
  const s = g.state;
  const log = g.log.slice();
  const by = s.pending?.color ?? s.turn;
  let next: State;
  let mark = g.mark;
  let swaps = g.swaps;
  try {
    switch (a.k) {
      case 'm': {
        const m = legalMoves(s).find((x) => x.from === a.from && x.to === a.to && x.promo === a.promo);
        if (!m) return null;
        next = applyMove(s, m);
        const trapped = !next.board[m.to] && next.fx.traps.length < s.fx.traps.length;
        const check = !next.result && inCheck(next, other(by)) ? '+' : next.result?.reason === 'checkmate' ? '#' : '';
        log.push({ text: `${NAME[by]}: ${moveText(s, m)}${check}${trapped ? ' and is destroyed by the Rune Trap!' : ''}`, kind: 'move', by });
        mark = [m.from, m.to];
        break;
      }
      case 'c': {
        const t = tryCast(s, a.cast);
        if (!t) return null;
        next = applyCast(s, a.cast);
        let extra = '';
        const spell = a.cast.as ?? a.cast.spell;
        if (spell === 'gust' && !next.board[a.cast.at[1]]) extra = ', onto the Rune Trap!';
        if (spell === 'timeslip') { const l = s.last[other(by)]!; extra = `: ${sqName(l.to)} → ${sqName(l.from)}`; mark = [l.to, l.from]; }
        else if (a.cast.at.length) mark = a.cast.at.slice();
        log.push({ text: `${NAME[by]} casts ${castText(a.cast, SPELL_NAMES)}${extra}`, kind: 'spell', by });
        break;
      }
      case 'd':
        if (!s.pending || !s.hands[by].includes(a.spell)) return null;
        next = discard(s, a.spell);
        log.push({ text: `${NAME[by]} discards ${SPELL_NAMES[a.spell]}.`, kind: 'note', by });
        break;
      case 'e':
        next = endTurn(s);
        break;
      case 'g': {
        if (a.p === 'swap') { next = s; swaps++; log.push({ text: 'The table is flipped. The players swap sides!', kind: 'god', by }); break; }
        const p = 'sq' in a ? s.board[a.sq] : null;
        next = a.p === 'flick' ? godFlick(s, a.sq) : a.p === 'anoint' ? godAnoint(s, a.sq) : a.p === 'chicken' ? godChicken(s, a.sq)
          : a.p === 'wish' ? godWish(s, a.c, a.spell) : godPass(s);
        if (next === s) return null;
        const where = 'sq' in a ? sqName(a.sq) : '';
        const what = p ? `the ${PIECE[p.t]} on ${where}` : '';
        log.push({
          text: a.p === 'flick' ? `A divine finger flicks ${what} into the abyss.`
            : a.p === 'anoint' ? `The heavens crown ${what}.`
            : a.p === 'chicken' ? `Poof! ${what[0].toUpperCase()}${what.slice(1)} is now a humble pawn.`
            : a.p === 'wish' ? `${NAME[a.c]} wishes for ${SPELL_NAMES[a.spell]}.`
            : `Time stops. ${NAME[s.turn]} loses a turn.`,
          kind: 'god', by,
        });
        if ('sq' in a) mark = [a.sq];
        break;
      }
    }
  } catch { return null; }
  if (a.k !== 'g') handNotes(s, next, log);
  if (!s.result) ending(next, log);
  return { state: next, log, mark, swaps };
}

export function replay(seed: number, acts: Act[]): Game {
  let g = startGame(seed);
  for (const a of acts) g = act(g, a) ?? g;
  return g;
}

/** The colour a player who started as `side` holds now (god swaps flip it). */
export const sideNow = (g: Game, side: Color): Color => (g.swaps % 2 ? other(side) : side);

/**
 * How many actions to keep so that the player is back at the start of their
 * latest turn in which they did something. -1 if there is nothing to take
 * back. `side` is the colour they started with, or 'both' for a shared board.
 */
export function takebackPoint(seed: number, acts: Act[], side: Color | 'both'): number {
  let g = startGame(seed);
  const mine = () => side === 'both' || (g.state.pending?.color ?? g.state.turn) === sideNow(g, side);
  const fresh = () => !g.state.flags.moved && !g.state.flags.cast && !g.state.pending && !g.state.result;
  let start = fresh() && mine() ? 0 : -1;
  let found = -1;
  for (let i = 0; i < acts.length; i++) {
    if (start >= 0 && mine()) found = start;
    g = act(g, acts[i]) ?? g;
    if (fresh() && mine() && acts[i].k !== 'g') start = i + 1;
  }
  return found;
}
