// Glue between chess.js and the board view, shared by every mode.

import { Chess, type Move, type Square } from 'chess.js';
import type { Sound } from './audio';
import type { Side } from './art/pieces';
import type { BoardState, Pieces } from './board/view';

export function pieces(chess: Chess): Pieces {
  const map: Pieces = new Map();
  for (const row of chess.board()) for (const p of row) if (p) map.set(p.square, { type: p.type, color: p.color });
  return map;
}

export function dests(chess: Chess): Map<Square, Square[]> {
  const map = new Map<Square, Square[]>();
  for (const m of chess.moves({ verbose: true })) {
    const list = map.get(m.from) ?? [];
    if (!list.includes(m.to)) list.push(m.to);
    map.set(m.from, list);
  }
  return map;
}

export function kingSquare(chess: Chess, side: Side): Square | null {
  return chess.findPiece({ type: 'k', color: side })[0] ?? null;
}

/** What the board should show; `movable` is who may move pieces now. */
export function boardState(chess: Chess, movable: Side | 'both' | null, last?: Pick<Move, 'from' | 'to'> | null): BoardState {
  const turn = chess.turn();
  const canMove = !chess.isGameOver() && (movable === 'both' || movable === turn);
  return {
    pieces: pieces(chess),
    dests: canMove ? dests(chess) : new Map(),
    lastMove: last ? [last.from, last.to] : null,
    check: chess.inCheck() ? kingSquare(chess, turn) : null,
  };
}

export function soundFor(move: Move, chess: Chess): Sound {
  if (chess.inCheck()) return 'check';
  if (move.captured) return 'capture';
  if (move.isKingsideCastle() || move.isQueensideCastle()) return 'castle';
  return 'move';
}

export function parseUci(uci: string): { from: Square; to: Square; promotion?: string } {
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] || undefined };
}

export interface Outcome { winner: Side | null; reason: string }

/** Why the game ended, or null while it goes on. */
export function outcome(chess: Chess): Outcome | null {
  if (chess.isCheckmate()) return { winner: chess.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: 'fifty-move rule' };
  return null;
}

/** Material difference and captured pieces, for the bars beside the board. */
export function material(chess: Chess): Record<Side, { captured: string[]; lead: number }> {
  const value: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const start: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const count: Record<Side, Record<string, number>> = { w: {}, b: {} };
  let score = 0;
  for (const row of chess.board()) for (const p of row) {
    if (!p) continue;
    count[p.color][p.type] = (count[p.color][p.type] ?? 0) + 1;
    score += (p.color === 'w' ? 1 : -1) * value[p.type];
  }
  // Each side shows the opponent's pieces it has taken, most valuable first.
  const taken = (side: Side) => ['q', 'r', 'b', 'n', 'p'].flatMap((t) => Array(Math.max(0, start[t] - (count[side][t] ?? 0))).fill(t));
  return { w: { captured: taken('b'), lead: Math.max(0, score) }, b: { captured: taken('w'), lead: Math.max(0, -score) } };
}
