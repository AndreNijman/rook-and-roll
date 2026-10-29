import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { PIECE_TYPES, SPRITE, drawPiece } from '../src/client/art/pieces';
import { BOTS, pickMove } from '../src/client/bots';
import { flip, formatScore, parseInfo, winPercent, type Line } from '../src/client/engine/uci';
import { boardState, material, outcome } from '../src/client/game';
import { classify, gameAccuracy, moveAccuracy, review } from '../src/client/review';

describe('pieces', () => {
  it('draws every piece as an outlined 16 x 16 sprite', () => {
    for (const t of PIECE_TYPES) for (const side of ['w', 'b'] as const) {
      const im = drawPiece(t, side);
      expect([im.w, im.h]).toEqual([SPRITE, SPRITE]);
      let opaque = 0;
      for (let i = 3; i < im.data.length; i += 4) if (im.data[i]) opaque++;
      expect(opaque).toBeGreaterThan(30);
      // Only outline ink may touch the sprite edge, so no outline is clipped.
      for (let i = 0; i < SPRITE; i++) for (const [x, y] of [[i, 0], [i, SPRITE - 1], [0, i], [SPRITE - 1, i]]) {
        const o = (y * SPRITE + x) * 4;
        if (im.data[o + 3]) expect([...im.data.subarray(o, o + 3)]).toEqual([0x26, 0x18, 0x1e]);
      }
    }
  });
});

describe('uci', () => {
  it('parses scores, multipv and the principal variation', () => {
    const l = parseInfo('info depth 12 seldepth 18 multipv 2 score cp -35 nodes 1000 nps 1 pv e7e5 g1f3 b8c6');
    expect(l).toEqual({ multipv: 2, depth: 12, score: { cp: -35 }, pv: ['e7e5', 'g1f3', 'b8c6'] });
    expect(parseInfo('info depth 20 score mate 3 pv h5f7')?.score).toEqual({ mate: 3 });
  });

  it('skips bound scores and lines without a pv', () => {
    expect(parseInfo('info depth 9 score cp 40 lowerbound pv e2e4')).toBeNull();
    expect(parseInfo('info depth 1 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfo('info string NNUE evaluation')).toBeNull();
  });

  it('turns scores into win chances', () => {
    expect(winPercent({ cp: 0 })).toBe(50);
    expect(winPercent({ cp: 300 })).toBeGreaterThan(75);
    expect(winPercent({ cp: -300 })).toBeCloseTo(100 - winPercent({ cp: 300 }));
    expect(winPercent({ mate: 2 })).toBe(100);
    expect(winPercent({ mate: -1 })).toBe(0);
    expect(flip({ mate: 2 })).toEqual({ mate: -2 });
    expect(formatScore({ cp: 140 })).toBe('+1.4');
    expect(formatScore({ mate: -3 })).toBe('-M3');
  });
});

describe('bots', () => {
  const lines: Line[] = [
    { multipv: 1, depth: 4, score: { cp: 50 }, pv: ['e2e4'] },
    { multipv: 2, depth: 4, score: { cp: 20 }, pv: ['d2d4'] },
    { multipv: 3, depth: 4, score: { cp: -600 }, pv: ['f2f3'] },
  ];

  it('are ordered by rating', () => {
    const r = BOTS.map((b) => b.rating);
    expect([...r].sort((a, b) => a - b)).toEqual(r);
  });

  it('strong bots always play the engine move', () => {
    const strong = BOTS.find((b) => b.temperature === 0)!;
    expect(pickMove(strong, lines, 'e2e4', () => 0.99)).toBe('e2e4');
  });

  it('weak bots spread their choice by how good each move is', () => {
    const pip = BOTS[0];
    const picks = new Set([0, 0.3, 0.6, 0.99].map((r) => pickMove(pip, lines, 'e2e4', () => r)));
    expect(picks.size).toBeGreaterThan(1);
    // A cooler bot almost never picks the losing line.
    const rook = BOTS.find((b) => b.id === 'rook')!;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const m = pickMove(rook, lines, 'e2e4', () => i / 1000);
      counts[m] = (counts[m] ?? 0) + 1;
    }
    expect(counts.f2f3 ?? 0).toBeLessThan(5);
    expect(counts.e2e4).toBeGreaterThan(counts.d2d4);
  });
});

describe('game', () => {
  it('only offers moves to the side allowed to move', () => {
    const c = new Chess();
    expect(boardState(c, 'w').dests?.size).toBe(10);
    expect(boardState(c, 'b').dests?.size).toBe(0);
    expect(boardState(c, null).dests?.size).toBe(0);
  });

  it('reports checkmate, stalemate and material', () => {
    const mate = new Chess();
    for (const m of ['f3', 'e5', 'g4', 'Qh4#']) mate.move(m);
    expect(outcome(mate)).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(boardState(mate, 'both').check).toBe('e1');
    expect(outcome(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))?.reason).toBe('stalemate');
    const up = material(new Chess('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
    expect(up.w).toEqual({ captured: ['q'], lead: 9 });
    expect(up.b.lead).toBe(0);
  });
});

describe('review', () => {
  it('grades moves by lost win chance', () => {
    expect(classify(0, true, false)).toBe('best');
    expect(classify(1, false, false)).toBe('excellent');
    expect(classify(7, false, false)).toBe('inaccuracy');
    expect(classify(15, false, false)).toBe('mistake');
    expect(classify(40, false, false)).toBe('blunder');
    expect(classify(40, false, true)).toBe('forced');
  });

  it('scores move accuracy from 100 down', () => {
    expect(moveAccuracy(60, 60)).toBe(100);
    expect(moveAccuracy(60, 70)).toBe(100);
    expect(moveAccuracy(80, 20)).toBeLessThan(10);
  });

  it('gives a clean game high accuracy and a blundered one less', () => {
    const steady = Array(21).fill(52);
    expect(gameAccuracy(steady, 'w')).toBeGreaterThan(98);
    const blunder = [...steady];
    for (let i = 11; i < 21; i++) blunder[i] = 10; // white throws it away on ply 10
    expect(gameAccuracy(blunder, 'w')!).toBeLessThan(gameAccuracy(steady, 'w')!);
    expect(gameAccuracy(blunder, 'b')).toBeGreaterThan(95);
  });

  it('attributes moves to the right side and counts them', () => {
    // White's win% jumps on ply 1: whoever played it blundered.
    const wins = [50, 50, 80, 80];
    const r = review(wins, [true, false, false], [false, false, false]);
    expect(r.moves.map((m) => m.cls)).toEqual(['best', 'blunder', 'excellent']);
    expect(r.counts.b.blunder).toBe(1);
    expect(r.counts.w.blunder).toBe(0);
    // With black moving first, ply 1 is white's, and white gained.
    const r2 = review(wins, [true, false, false], [false, false, false], 'b');
    expect(r2.moves[1].cls).toBe('excellent');
    expect(r2.counts.b.best).toBe(1);
  });
});
