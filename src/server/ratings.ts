// Online ratings: Glicko-2 with one rating period per game, as on Lichess,
// and a deviation that grows back by one period per idle day.

import { DEFAULT, decay, provisional, update, type Rating } from '../shared/glicko';
import { GAME_TAU, type Rated } from '../shared/online';

export interface Stored extends Rating { games: number; updated: number }

const DAY = 86_400_000;

export const fresh = (now: number): Stored => ({ ...DEFAULT, games: 0, updated: now });

/** A stored rating as it stands at `now`, idle days included. */
export function current(r: Stored, now: number): Stored {
  return { ...r, ...decay(r, Math.floor((now - r.updated) / DAY)) };
}

export const shown = (r: Rating): Rated => ({ rating: Math.round(r.rating), provisional: provisional(r) });

/** Both players' ratings after a game; `score` is White's (1, 0.5 or 0). */
export function rateGame(w: Stored, b: Stored, score: number, now: number): { w: Stored; b: Stored } {
  const cw = current(w, now), cb = current(b, now);
  const nw = update(cw, [{ opponent: cb, score }], GAME_TAU);
  const nb = update(cb, [{ opponent: cw, score: 1 - score }], GAME_TAU);
  return {
    w: { ...nw, games: w.games + 1, updated: now },
    b: { ...nb, games: b.games + 1, updated: now },
  };
}
