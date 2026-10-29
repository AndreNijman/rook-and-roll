import { describe, expect, it } from 'vitest';
import { PuzzleRun, bandFor, fromRow } from '../src/client/puzzle';

// Real rows from the Lichess database.
const fork = fromRow(['00008', 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24', 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1', 1811, 'hangingPiece']);
const mateIn1 = fromRow(['Vr4a0', '1r1qkb1r/Q4ppp/4pn2/2p1N3/6P1/1Ppb3P/P4PB1/R1B1K2R b KQk - 1 16', 'd3b5 a7f7', 1202, 'mate mateIn1']);

describe('puzzle run', () => {
  it('plays the opponent move first, then alternates', () => {
    const run = new PuzzleRun(fork);
    expect(run.start().lan).toBe('f2g3');
    expect(run.side).toBe('w');
    expect(run.attempt('h6h7').kind).toBe('wrong');
    const a = run.attempt('e6e7');
    expect(a.kind).toBe('correct');
    if (a.kind === 'correct') expect(a.reply.lan).toBe('b2b1');
    expect(run.attempt('b3c1').kind).toBe('correct');
    expect(run.attempt('h6c1').kind).toBe('solved');
    expect(run.solved).toBe(true);
  });

  it('accepts any mating move, not only the listed one', () => {
    const run = new PuzzleRun(mateIn1);
    run.start();
    expect(run.attempt('a7f7').kind).toBe('solved');
  });

  it('rejects illegal moves without changing the position', () => {
    const run = new PuzzleRun(mateIn1);
    run.start();
    const fen = run.chess.fen();
    expect(run.attempt('a1a8').kind).toBe('wrong');
    expect(run.chess.fen()).toBe(fen);
  });

  it('maps ratings to bands', () => {
    expect(bandFor(100)).toBe(400);
    expect(bandFor(1499)).toBe(1400);
    expect(bandFor(3300)).toBe(2900);
  });
});
