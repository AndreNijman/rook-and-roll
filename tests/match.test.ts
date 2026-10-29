import { describe, expect, it } from 'vitest';
import { Match } from '../src/server/match';
import { rateGame, fresh } from '../src/server/ratings';
import { FIRST_MOVE_MS, CLAIM_MS, canMate, categoryOf } from '../src/shared/online';

const seat = (pid: string) => ({ pid, info: { name: pid, account: true } });
const game = (now = 0) => Match.create({ id: 'abcd1234', tc: '3+2', rated: true, seats: { w: seat('W'), b: seat('B') } }, now);

describe('Match', () => {
  it('runs no clock until both sides have moved, then adds the increment', () => {
    const m = game();
    expect(m.move('W', 'e2e4', 0, 10_000)).toBeNull();
    expect(m.s.clocks.w).toBe(180_000);
    expect(m.move('B', 'e7e5', 1, 20_000)).toBeNull();
    expect(m.s.clocks.b).toBe(180_000);
    expect(m.view(20_000).running).toBe(true);
    // White takes 5 s: 180 - 5 + 2.
    expect(m.move('W', 'g1f3', 2, 25_000)).toBeNull();
    expect(m.s.clocks.w).toBe(177_000);
  });

  it('rejects moves out of turn, illegal moves and spectators, and ignores resends', () => {
    const m = game();
    expect(m.move('B', 'e7e5', 0, 1)).toBe('Not your move.');
    expect(m.move('W', 'e2e5', 0, 1)).toBe('Illegal move.');
    expect(m.move('X', 'e2e4', 0, 1)).toBe('You are watching this game.');
    expect(m.move('W', 'e2e4', 0, 1)).toBeNull();
    expect(m.move('W', 'e2e4', 0, 2)).toBeNull();
    expect(m.s.moves).toEqual(['e2e4']);
  });

  it('aborts when the first move does not come, and never rates it', () => {
    const m = game();
    expect(m.deadline()).toBe(FIRST_MOVE_MS);
    expect(m.tick(FIRST_MOVE_MS)).toBe(true);
    expect(m.s.result).toEqual({ winner: null, reason: 'aborted' });
    expect(m.ratable).toBe(false);
  });

  it('flags on time, and calls it a draw when the winner cannot mate', () => {
    const m = game();
    m.move('W', 'e2e4', 0, 0); m.move('B', 'e7e5', 1, 0);
    expect(m.deadline()).toBe(180_000);
    expect(m.tick(179_999)).toBe(false);
    expect(m.tick(180_000)).toBe(true);
    expect(m.s.result).toMatchObject({ winner: 'b', reason: 'timeout' });
    expect(m.ratable).toBe(true);
    expect(canMate('8/8/8/4k3/8/8/8/4K2N w - - 0 1', 'w')).toBe(false);
    expect(canMate('8/8/8/4k3/8/8/8/4KNN1 w - - 0 1', 'w')).toBe(true);
  });

  it('a late move loses on time instead of being played', () => {
    const m = game();
    m.move('W', 'e2e4', 0, 0); m.move('B', 'e7e5', 1, 0);
    expect(m.move('W', 'g1f3', 2, 200_000)).toBeNull();
    expect(m.s.moves).toHaveLength(2);
    expect(m.s.result?.reason).toBe('timeout');
  });

  it('ends on checkmate', () => {
    const m = game();
    ['f2f3', 'e7e5', 'g2g4', 'd8h4'].forEach((u, i) => m.move(i % 2 ? 'B' : 'W', u, i, i));
    expect(m.s.result).toMatchObject({ winner: 'b', reason: 'checkmate' });
  });

  it('agrees a draw, and a move declines the offer', () => {
    const m = game();
    m.move('W', 'e2e4', 0, 0);
    expect(m.draw('B', 1)).toBe('Make a move first.');
    m.move('B', 'e7e5', 1, 0);
    m.draw('W', 1);
    expect(m.s.drawOffer).toBe('w');
    m.move('W', 'g1f3', 2, 2);
    expect(m.s.drawOffer).toBe('w');
    m.move('B', 'b8c6', 3, 3);
    expect(m.s.drawOffer).toBeNull();
    m.draw('W', 4); m.draw('B', 5);
    expect(m.s.result).toMatchObject({ winner: null, reason: 'agreement' });
  });

  it('resigning before both have moved aborts; after, it loses', () => {
    const a = game();
    a.resign('W', 1);
    expect(a.s.result?.reason).toBe('aborted');
    const b = game();
    b.move('W', 'e2e4', 0, 0); b.move('B', 'e7e5', 1, 0);
    expect(b.abortBy('W', 1)).toMatch(/Too late/);
    b.resign('W', 1000);
    expect(b.s.result).toMatchObject({ winner: 'b', reason: 'resignation' });
    expect(b.s.clocks.w).toBe(179_000);
  });

  it('lets a player claim a game the opponent left', () => {
    const m = game();
    m.move('W', 'e2e4', 0, 0); m.move('B', 'e7e5', 1, 0);
    m.setGone('b', true, 1000);
    expect(m.claim('W', 1000 + CLAIM_MS - 1)).toMatch(/still here/);
    expect(m.claim('W', 1000 + CLAIM_MS)).toBeNull();
    expect(m.s.result).toMatchObject({ winner: 'w', reason: 'abandonment' });
  });

  it('seats a friend in the open seat, then only spectators', () => {
    const m = Match.create({ id: 'abcd1234', tc: '5+3', rated: true, seats: { w: seat('W'), b: null } }, 0);
    expect(m.s.rated).toBe(false);
    expect(m.s.status).toBe('waiting');
    expect(m.join('W', seat('W').info, 1)).toBe('w');
    expect(m.join('F', seat('F').info, 2)).toBe('b');
    expect(m.s.status).toBe('playing');
    expect(m.join('X', seat('X').info, 3)).toBeNull();
  });

  it('agrees a rematch once both ask', () => {
    const m = game();
    m.resign('W', 1);
    expect(m.rematch('W')).toBe(false);
    expect(m.rematch('B')).toBe(true);
  });
});

describe('online ratings', () => {
  it('moves the winner up and the loser down by the same amount for equal players', () => {
    const r = rateGame(fresh(0), fresh(0), 1, 0);
    expect(r.w.rating).toBeGreaterThan(1600);
    expect(r.w.rating - 1500).toBeCloseTo(1500 - r.b.rating, 6);
    expect(r.w.games).toBe(1);
  });

  it('sorts time controls into categories as Lichess does', () => {
    expect(categoryOf('1+0')).toBe('bullet');
    expect(categoryOf('2+1')).toBe('bullet');
    expect(categoryOf('3+2')).toBe('blitz');
    expect(categoryOf('10+0')).toBe('rapid');
    expect(categoryOf('15+10')).toBe('rapid');
    expect(categoryOf('30+0')).toBe('classical');
  });
});
