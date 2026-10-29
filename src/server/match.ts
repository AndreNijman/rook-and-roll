// One online game's rules and clocks, kept apart from the Durable Object that
// stores it so the tests can drive it with a fake clock. Every method takes
// `now` (ms) rather than reading the time itself.
//
// Clocks follow Lichess: neither runs until both sides have made a move, and
// until then each side has FIRST_MOVE_MS to move or the game is aborted.
// Aborted games are never rated.

import { Chess } from 'chess.js';
import {
  CLAIM_MS, FIRST_MOVE_MS, canMate, clockOf,
  type GameView, type PlayerInfo, type Result, type Side, type Status, type TimeControl,
} from '../shared/online';

export interface Seat { pid: string; info: PlayerInfo }

export interface MatchState {
  id: string;
  tc: TimeControl;
  rated: boolean;
  status: Status;
  seats: Record<Side, Seat | null>;
  moves: string[];
  clocks: Record<Side, number>;
  turnStart: number;
  drawOffer: Side | null;
  rematchOffer: Side | null;
  rematchId?: string;
  gone: Partial<Record<Side, number>>;
  result?: Result;
  created: number;
  ended?: number;
}

/** A waiting friend game, or a finished one, is dropped after this long. */
export const KEEP_MS = 24 * 3600_000;

export const other = (s: Side): Side => (s === 'w' ? 'b' : 'w');

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export class Match {
  readonly chess: Chess;

  constructor(readonly s: MatchState) {
    this.chess = new Chess();
    for (const m of s.moves) this.chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  }

  static create(o: { id: string; tc: TimeControl; rated: boolean; seats: Record<Side, Seat | null> }, now: number): Match {
    const { base } = clockOf(o.tc);
    const full = Boolean(o.seats.w && o.seats.b);
    return new Match({
      id: o.id, tc: o.tc, rated: o.rated && full, status: full ? 'playing' : 'waiting', seats: o.seats,
      moves: [], clocks: { w: base, b: base }, turnStart: now, drawOffer: null, rematchOffer: null,
      gone: {}, created: now,
    });
  }

  get running(): boolean { return this.s.moves.length >= 2; }
  get turn(): Side { return this.chess.turn(); }

  sideOf(pid: string): Side | null {
    if (this.s.seats.w?.pid === pid) return 'w';
    if (this.s.seats.b?.pid === pid) return 'b';
    return null;
  }

  /** Seat a player: their own seat, or the open one in a friend game. Null for spectators. */
  join(pid: string, info: PlayerInfo, now: number): Side | null {
    const mine = this.sideOf(pid);
    if (mine) return mine;
    if (this.s.status !== 'waiting') return null;
    const open: Side | null = !this.s.seats.w ? 'w' : !this.s.seats.b ? 'b' : null;
    if (!open) return null;
    this.s.seats[open] = { pid, info };
    this.s.status = 'playing';
    this.s.turnStart = now;
    return open;
  }

  /** Time left for `side` at `now`. */
  left(side: Side, now: number): number {
    return this.running && this.s.status === 'playing' && this.turn === side
      ? this.s.clocks[side] - (now - this.s.turnStart)
      : this.s.clocks[side];
  }

  /** An error message, or null when the move was played (or the mover flagged first). */
  move(pid: string, uci: string, ply: number, now: number): string | null {
    const side = this.sideOf(pid);
    if (this.s.status !== 'playing') return 'The game is not on.';
    if (!side) return 'You are watching this game.';
    if (ply !== this.s.moves.length) return null; // a resend of a move already played
    if (this.turn !== side) return 'Not your move.';
    if (!UCI.test(uci)) return 'Illegal move.';
    if (this.tick(now)) return null;
    const running = this.running;
    const left = this.left(side, now);
    try {
      this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch { return 'Illegal move.'; }
    if (running) this.s.clocks[side] = left + clockOf(this.s.tc).inc;
    this.s.moves.push(uci);
    this.s.turnStart = now;
    if (this.s.drawOffer === other(side)) this.s.drawOffer = null;
    const c = this.chess;
    if (c.isCheckmate()) this.end({ winner: side, reason: 'checkmate' }, now);
    else if (c.isStalemate()) this.end({ winner: null, reason: 'stalemate' }, now);
    else if (c.isInsufficientMaterial()) this.end({ winner: null, reason: 'insufficient material' }, now);
    else if (c.isThreefoldRepetition()) this.end({ winner: null, reason: 'repetition' }, now);
    else if (c.isDrawByFiftyMoves()) this.end({ winner: null, reason: 'the 50-move rule' }, now);
    return null;
  }

  /** Apply time-outs due by `now`; true if the game ended. */
  tick(now: number): boolean {
    if (this.s.status !== 'playing') return false;
    if (!this.running) {
      if (now - this.s.turnStart >= FIRST_MOVE_MS) { this.abort(now); return true; }
      return false;
    }
    const side = this.turn;
    if (this.left(side, now) > 0) return false;
    this.s.clocks[side] = 0;
    const winner = other(side);
    this.end(canMate(this.chess.fen(), winner)
      ? { winner, reason: 'timeout' }
      : { winner: null, reason: 'timeout vs insufficient material' }, now);
    return true;
  }

  resign(pid: string, now: number): string | null {
    const side = this.sideOf(pid);
    if (!side || this.s.status !== 'playing') return 'Nothing to resign.';
    if (!this.running) { this.abort(now); return null; }
    this.freeze(now);
    this.end({ winner: other(side), reason: 'resignation' }, now);
    return null;
  }

  abortBy(pid: string, now: number): string | null {
    if (!this.sideOf(pid) || this.s.status === 'over') return 'Nothing to abort.';
    if (this.running) return 'Too late to abort: resign instead.';
    this.abort(now);
    return null;
  }

  draw(pid: string, now: number): string | null {
    const side = this.sideOf(pid);
    if (!side || this.s.status !== 'playing') return 'The game is not on.';
    if (!this.running) return 'Make a move first.';
    if (this.s.drawOffer === other(side)) {
      this.freeze(now);
      this.end({ winner: null, reason: 'agreement' }, now);
    } else this.s.drawOffer = side;
    return null;
  }

  decline(pid: string): void {
    const side = this.sideOf(pid);
    if (side && this.s.drawOffer === other(side)) this.s.drawOffer = null;
  }

  /** Win (or abort) a game the opponent has left for CLAIM_MS. */
  claim(pid: string, now: number): string | null {
    const side = this.sideOf(pid);
    if (!side || this.s.status !== 'playing') return 'The game is not on.';
    const since = this.s.gone[other(side)];
    if (since === undefined || now - since < CLAIM_MS) return 'Your opponent is still here.';
    if (!this.running) { this.abort(now); return null; }
    this.freeze(now);
    this.end({ winner: side, reason: 'abandonment' }, now);
    return null;
  }

  /** Ask for a rematch; true once both have asked. */
  rematch(pid: string): boolean {
    const side = this.sideOf(pid);
    if (!side || this.s.status !== 'over' || this.s.rematchId || !this.s.seats.w || !this.s.seats.b) return false;
    if (this.s.rematchOffer === other(side)) return true;
    this.s.rematchOffer = side;
    return false;
  }

  setGone(side: Side, gone: boolean, now: number): void {
    if (gone) this.s.gone[side] ??= now;
    else delete this.s.gone[side];
  }

  /** When the object next needs waking: a flag, a first-move deadline, or clean-up. */
  deadline(): number {
    const s = this.s;
    if (s.status === 'playing') return this.running ? s.turnStart + s.clocks[this.turn] : s.turnStart + FIRST_MOVE_MS;
    return (s.ended ?? s.created) + KEEP_MS;
  }

  /** A game decided and worth rating: rated, and both sides moved. */
  get ratable(): boolean {
    return this.s.rated && this.s.status === 'over' && this.s.result?.reason !== 'aborted';
  }

  view(now: number): GameView {
    const s = this.s;
    return {
      id: s.id, tc: s.tc, rated: s.rated, status: s.status,
      players: { w: s.seats.w?.info ?? null, b: s.seats.b?.info ?? null },
      moves: s.moves, clocks: s.clocks, turnStart: s.turnStart, now,
      running: this.running && s.status === 'playing',
      firstMoveBy: s.status === 'playing' && !this.running ? s.turnStart + FIRST_MOVE_MS : undefined,
      drawOffer: s.drawOffer, rematchOffer: s.rematchOffer, rematchId: s.rematchId,
      gone: s.gone, result: s.result,
    };
  }

  /** Stop the running clock at `now`, so a finished game shows the time each side had left. */
  private freeze(now: number): void {
    if (this.running) this.s.clocks[this.turn] = Math.max(0, this.left(this.turn, now));
  }

  private abort(now: number): void {
    this.end({ winner: null, reason: 'aborted' }, now);
  }

  private end(result: Result, now: number): void {
    this.s.status = 'over';
    this.s.result = result;
    this.s.drawOffer = null;
    this.s.ended = now;
  }
}
