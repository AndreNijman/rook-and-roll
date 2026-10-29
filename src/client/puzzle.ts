// Puzzles from the Lichess database. A puzzle's FEN is the position before
// the opponent's move; its first move is that move, and the player answers
// from there, the two sides alternating through the list. Any move that
// mates is accepted, since a mate is a mate whichever way it is given.

import { Chess, type Move } from 'chess.js';
import { parseUci } from './game';

export type PuzzleRow = [id: string, fen: string, moves: string, rating: number, themes: string];

export interface Puzzle { id: string; fen: string; moves: string[]; rating: number; themes: string[] }

export const fromRow = ([id, fen, moves, rating, themes]: PuzzleRow): Puzzle =>
  ({ id, fen, moves: moves.split(' '), rating, themes: themes ? themes.split(' ') : [] });

export type Attempt =
  | { kind: 'wrong' }
  | { kind: 'correct'; move: Move; reply: Move }
  | { kind: 'solved'; move: Move };

export class PuzzleRun {
  readonly chess: Chess;
  /** Index into puzzle.moves of the move the player must find next. */
  next = 0;
  history: Move[] = [];

  constructor(readonly puzzle: Puzzle) {
    this.chess = new Chess(puzzle.fen);
  }

  /** Play the opponent's opening move; the player moves after it. */
  start(): Move {
    const m = this.chess.move(parseUci(this.puzzle.moves[0]));
    this.history.push(m);
    this.next = 1;
    return m;
  }

  get solved(): boolean { return this.next >= this.puzzle.moves.length; }

  /** The side the player solves for. */
  get side(): 'w' | 'b' { return new Chess(this.puzzle.fen).turn() === 'w' ? 'b' : 'w'; }

  /** The move the player should play now, in UCI. */
  get expected(): string { return this.puzzle.moves[this.next] ?? ''; }

  attempt(uci: string): Attempt {
    if (this.solved) return { kind: 'wrong' };
    const probe = new Chess(this.chess.fen());
    let move: Move;
    try { move = probe.move(parseUci(uci)); } catch { return { kind: 'wrong' }; }
    if (uci !== this.expected && !probe.isCheckmate()) return { kind: 'wrong' };
    this.chess.move(move);
    this.history.push(move);
    this.next++;
    if (probe.isCheckmate() || this.solved) {
      this.next = this.puzzle.moves.length;
      return { kind: 'solved', move };
    }
    const reply = this.chess.move(parseUci(this.puzzle.moves[this.next]));
    this.history.push(reply);
    this.next++;
    return { kind: 'correct', move, reply };
  }
}

/** Plain-English names for the themes the shards keep. */
export const THEME_NAMES: Record<string, string> = {
  mate: 'Checkmate', mateIn1: 'Mate in 1', mateIn2: 'Mate in 2', mateIn3: 'Mate in 3', fork: 'Fork', pin: 'Pin',
  skewer: 'Skewer', hangingPiece: 'Hanging piece', sacrifice: 'Sacrifice', discoveredAttack: 'Discovered attack',
  doubleCheck: 'Double check', deflection: 'Deflection', attraction: 'Attraction', interference: 'Interference',
  clearance: 'Clearance', trappedPiece: 'Trapped piece', promotion: 'Promotion', underPromotion: 'Underpromotion',
  enPassant: 'En passant', castling: 'Castling', zugzwang: 'Zugzwang', quietMove: 'Quiet move', xRayAttack: 'X-ray',
  backRankMate: 'Back-rank mate', smotheredMate: 'Smothered mate', endgame: 'Endgame', opening: 'Opening',
  middlegame: 'Middlegame',
};

export const BAND_MIN = 400, BAND_MAX = 2900;
export const bandFor = (rating: number) => Math.max(BAND_MIN, Math.min(BAND_MAX, Math.floor(rating / 100) * 100));

const shards = new Map<number, Promise<Puzzle[]>>();

export function loadBand(band: number): Promise<Puzzle[]> {
  let p = shards.get(band);
  if (!p) {
    p = fetch(new URL(`puzzles/${band}.json`, document.baseURI).href)
      .then((r) => { if (!r.ok) throw new Error(`puzzles ${band}: HTTP ${r.status}`); return r.json() as Promise<PuzzleRow[]>; })
      .then((rows) => rows.map(fromRow));
    p.catch(() => shards.delete(band));
    shards.set(band, p);
  }
  return p;
}

/** A puzzle near `rating` that isn't in `skip`, a little above or below at random. */
export async function pickPuzzle(rating: number, skip: Set<string>, rand: () => number = Math.random): Promise<Puzzle> {
  const target = rating + (rand() - 0.4) * 200;
  const list = await loadBand(bandFor(target));
  const fresh = list.filter((p) => !skip.has(p.id));
  const pool = fresh.length ? fresh : list;
  pool.sort((a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target));
  return pool[Math.floor(rand() * Math.min(12, pool.length))];
}
