// Online play: the messages between the browser and the chess relay, and the
// rules both sides agree on (time controls, rating categories). The relay is
// authoritative; it sends the whole game after every change, since a chess
// game is a few hundred bytes.

export type Side = 'w' | 'b';

/** Minutes + increment seconds, as on every chess site. */
export const TIME_CONTROLS = ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0'] as const;
export type TimeControl = (typeof TIME_CONTROLS)[number];
export const isTimeControl = (s: unknown): s is TimeControl => TIME_CONTROLS.includes(s as TimeControl);

export function clockOf(tc: TimeControl): { base: number; inc: number } {
  const [m, s] = tc.split('+').map(Number);
  return { base: m * 60_000, inc: s * 1000 };
}

export type Category = 'bullet' | 'blitz' | 'rapid' | 'classical';
export const CATEGORIES: Category[] = ['bullet', 'blitz', 'rapid', 'classical'];

/** Lichess's split: estimated game length is base + 40 increments. */
export function categoryOf(tc: TimeControl): Category {
  const { base, inc } = clockOf(tc);
  const est = (base + 40 * inc) / 1000;
  return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical';
}

/** Glicko-2 system constant for games, the same as the puzzle trainer's. */
export const GAME_TAU = 0.75;
/** No first move within this long after the clock is set: the game is aborted. */
export const FIRST_MOVE_MS = 30_000;
/** How long an opponent must be gone before the other player can claim the game. */
export const CLAIM_MS = 30_000;

export interface Rated { rating: number; provisional: boolean }

export interface PlayerInfo {
  name: string;
  /** Signed in to a games account; guests play unrated. */
  account: boolean;
  /** Rating in this game's category, when the player has an account. */
  rating?: Rated;
}

export type Status = 'waiting' | 'playing' | 'over';

export interface Result {
  winner: Side | null;
  reason: string;
  /** Rating change per side, for rated games. */
  change?: Partial<Record<Side, { before: number; after: number }>>;
}

export interface GameView {
  id: string;
  tc: TimeControl;
  rated: boolean;
  status: Status;
  players: Record<Side, PlayerInfo | null>;
  /** Moves in UCI. */
  moves: string[];
  /** Time left for each side when the current turn began, in ms. */
  clocks: Record<Side, number>;
  /** Server time the current turn began. */
  turnStart: number;
  /** Server time this view was sent, to line the clocks up with the browser's. */
  now: number;
  /** The clock runs once both sides have moved; before that the first-move timer does. */
  running: boolean;
  /** When the player to move must make their first move, before the clock starts. */
  firstMoveBy?: number;
  drawOffer: Side | null;
  rematchOffer: Side | null;
  rematchId?: string;
  /** Since when each side has had no connection. */
  gone: Partial<Record<Side, number>>;
  result?: Result;
}

export type GameClientMsg =
  | { t: 'move'; uci: string; ply: number }
  | { t: 'resign' }
  | { t: 'abort' }
  | { t: 'draw' }
  | { t: 'decline' }
  | { t: 'claim' }
  | { t: 'rematch' };

export type GameServerMsg =
  | { t: 'game'; game: GameView; you: Side | null }
  | { t: 'error'; message: string };

export type LobbyClientMsg =
  | { t: 'seek'; tc: TimeControl; rated: boolean }
  | { t: 'cancel' }
  | { t: 'friend'; tc: TimeControl; side: Side | 'random' };

export type LobbyServerMsg =
  | { t: 'hello'; name: string; account: boolean; ratings: Partial<Record<Category, Rated & { games: number }>> }
  | { t: 'counts'; seeking: Partial<Record<TimeControl, number>>; online: number }
  | { t: 'seeking'; tc: TimeControl; rated: boolean }
  | { t: 'matched'; id: string }
  | { t: 'created'; id: string }
  | { t: 'error'; message: string };

export const GAME_ID = /^[a-z0-9]{8}$/;

/** A side has mating material: anything more than a bare king or king and one minor piece. */
export function canMate(fen: string, side: Side): boolean {
  const board = fen.split(' ')[0];
  let minors = 0;
  for (const ch of board) {
    const own = side === 'w' ? ch >= 'A' && ch <= 'Z' : ch >= 'a' && ch <= 'z';
    if (!own) continue;
    const p = ch.toLowerCase();
    if (p === 'p' || p === 'q' || p === 'r') return true;
    if (p === 'n' || p === 'b') minors++;
  }
  return minors >= 2;
}
