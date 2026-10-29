// Game review maths, after Lichess: each move is judged by how much winning
// chance it gave away, and a game's accuracy blends a volatility-weighted
// mean of the move accuracies with their harmonic mean, so a single blunder
// in a quiet position costs more than a slip in chaos. Pure: no engine here.

import type { Side } from './art/pieces';

export type MoveClass = 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'forced';

export const CLASS_INFO: Record<MoveClass, { label: string; mark: string; color: string }> = {
  best: { label: 'Best', mark: '★', color: '#8ad05a' },
  excellent: { label: 'Excellent', mark: '!', color: '#84d4ae' },
  good: { label: 'Good', mark: '✓', color: '#9ad0f0' },
  inaccuracy: { label: 'Inaccuracy', mark: '?!', color: '#f0d060' },
  mistake: { label: 'Mistake', mark: '?', color: '#e8a040' },
  blunder: { label: 'Blunder', mark: '??', color: '#d8484a' },
  forced: { label: 'Forced', mark: '□', color: '#c8c0e0' },
};

export const CLASS_ORDER: MoveClass[] = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];

/** `loss` is the drop in the mover's win%, 0-100. */
export function classify(loss: number, best: boolean, forced: boolean): MoveClass {
  if (forced) return 'forced';
  if (best) return 'best';
  if (loss < 2) return 'excellent';
  if (loss < 5) return 'good';
  if (loss < 10) return 'inaccuracy';
  if (loss < 20) return 'mistake';
  return 'blunder';
}

/** One move's accuracy from the mover's win% before and after, 0-100. */
export function moveAccuracy(before: number, after: number): number {
  if (after >= before) return 100;
  const raw = 103.1668 * Math.exp(-0.04354 * (before - after)) - 3.1669 + 1;
  return Math.max(0, Math.min(100, raw));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

/**
 * A side's accuracy over a game. `wins` is white's win% for every position,
 * starting with the initial one. `first` is the side that moved first.
 */
export function gameAccuracy(wins: number[], side: Side, first: Side = 'w'): number | null {
  if (wins.length < 2) return null;
  const size = Math.max(2, Math.min(8, Math.floor((wins.length - 1) / 10)));
  const windows: number[][] = [];
  for (let i = 0; i < size - 2; i++) windows.push(wins.slice(0, size));
  for (let i = 0; i + size <= wins.length; i++) windows.push(wins.slice(i, i + size));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, stddev(w))));
  const acc: number[] = [], wt: number[] = [];
  for (let i = 0; i + 1 < wins.length; i++) {
    if ((i % 2 === 0) !== (side === first)) continue;
    const pov = (x: number) => (side === 'w' ? x : 100 - x);
    acc.push(moveAccuracy(pov(wins[i]), pov(wins[i + 1])));
    wt.push(weights[i] ?? weights[weights.length - 1]);
  }
  if (!acc.length) return null;
  const weighted = acc.reduce((s, a, i) => s + a * wt[i], 0) / wt.reduce((a, b) => a + b, 0);
  const harmonic = acc.length / acc.reduce((s, a) => s + 1 / Math.max(a, 1), 0);
  return (weighted + harmonic) / 2;
}

export interface ReviewedMove { cls: MoveClass; loss: number; accuracy: number }

export interface Review {
  moves: ReviewedMove[];
  accuracy: Record<Side, number | null>;
  counts: Record<Side, Record<MoveClass, number>>;
}

/**
 * Judge a game. `wins[i]` is white's win% before ply i (one more entry than
 * moves), `best[i]` whether ply i was the engine's choice, `forced[i]` whether
 * it was the only legal move. White plays the even plies unless `firstSide`
 * says the game started with black to move.
 */
export function review(wins: number[], best: boolean[], forced: boolean[], firstSide: Side = 'w'): Review {
  const blank = () => Object.fromEntries([...CLASS_ORDER, 'forced'].map((c) => [c, 0])) as Record<MoveClass, number>;
  const counts: Record<Side, Record<MoveClass, number>> = { w: blank(), b: blank() };
  const moves = best.map((isBest, i) => {
    const side: Side = (i % 2 === 0) === (firstSide === 'w') ? 'w' : 'b';
    const pov = (x: number) => (side === 'w' ? x : 100 - x);
    const before = pov(wins[i]), after = pov(wins[i + 1]);
    const loss = Math.max(0, before - after);
    const cls = classify(loss, isBest, forced[i]);
    counts[side][cls]++;
    return { cls, loss, accuracy: moveAccuracy(before, after) };
  });
  return { moves, accuracy: { w: gameAccuracy(wins, 'w', firstSide), b: gameAccuracy(wins, 'b', firstSide) }, counts };
}
