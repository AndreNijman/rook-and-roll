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

describe('Match: Spell Chess', () => {
  const sq = (n: string) => n.charCodeAt(0) - 97 + (Number(n[1]) - 1) * 8;
  const mv = (uci: string) => ({ k: 'm', from: sq(uci.slice(0, 2)), to: sq(uci.slice(2, 4)) });
  const spell = (now = 0) => Match.create({ id: 'abcd1234', tc: '3+2', rated: true, seats: { w: seat('W'), b: seat('B') }, variant: 'spell', seed: 9 }, now);
  const n = (m: Match) => m.s.acts!.length;

  it('is never rated, and sends the seed and actions instead of moves', () => {
    const m = spell();
    expect(m.s.rated).toBe(false);
    expect(m.act('W', mv('e2e4'), 0, 1000)).toBeNull();
    const v = m.view(1000);
    expect(v.variant).toBe('spell');
    expect(v.spell).toEqual({ seed: 9, acts: [{ k: 'm', from: 12, to: 28 }] });
    expect(v.moves).toEqual([]);
    expect(v.turn).toBe('b');
    expect(Match.create({ id: 'x', tc: '3+2', rated: true, seats: { w: seat('W'), b: seat('B') } }, 0).view(0).variant).toBeUndefined();
  });

  it('rejects out-of-turn, illegal, malformed and god actions, and ignores resends', () => {
    const m = spell();
    expect(m.act('B', mv('e7e5'), 0, 1)).toBe('Not your turn.');
    expect(m.act('X', mv('e2e4'), 0, 1)).toBe('You are watching this game.');
    expect(m.act('W', mv('e2e5'), 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'g', p: 'flick', sq: 59 }, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'g', p: 'wish', spell: 'smite', c: 'w' }, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'm', from: 12, to: 'x' }, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'm', from: 12.5, to: 28 }, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'c', cast: { spell: 'blink', at: [1] } }, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'c', cast: { spell: 'smite', at: [52, -1] } }, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', null, 0, 1)).toBe('Illegal action.');
    expect(m.act('W', { k: 'e' }, 0, 1)).toBe('Illegal action.');
    expect(m.move('W', 'e2e4', 0, 1)).toBe('Illegal move.');
    expect(n(m)).toBe(0);
    expect(m.act('W', mv('e2e4'), 0, 1)).toBeNull();
    expect(m.act('W', mv('e2e4'), 0, 2)).toBeNull(); // resend
    expect(n(m)).toBe(1);
    expect(spell().move('W', 'e2e4', 0, 1)).toBe('Illegal move.');
    expect(game().act('W', mv('e2e4'), 0, 1)).toBe('This is not a Spell Chess game.');
  });

  it('keeps the clock running through a turn and adds the increment when it passes', () => {
    const m = spell();
    m.act('W', mv('e2e4'), n(m), 0);
    m.act('B', mv('d7d5'), n(m), 0);
    expect(m.running).toBe(true);
    // White captures after 5 s and draws Frost Nova: still White's turn, clock still running.
    expect(m.act('W', mv('e4d5'), n(m), 5000)).toBeNull();
    expect(m.spell!.state.hands.w).toEqual(['frost']);
    expect(m.turn).toBe('w');
    expect(m.s.clocks.w).toBe(180_000);
    expect(m.left('w', 8000)).toBe(172_000);
    expect(m.act('B', mv('d8d5'), n(m), 8000)).toBe('Not your turn.');
    // The cast 4 s later ends the turn: 180 - 9 + 2.
    expect(m.act('W', { k: 'c', cast: { spell: 'frost', at: [sq('c7')] } }, n(m), 9000)).toBeNull();
    expect(m.turn).toBe('b');
    expect(m.s.clocks.w).toBe(173_000);
    expect(m.s.turnStart).toBe(9000);
    expect(m.deadline()).toBe(189_000);
    // The frozen queen may not take back.
    expect(m.act('B', mv('d8d5'), n(m), 9500)).toBe('Illegal action.');
  });

  it('flags on time whatever the material, and aborts without a first move', () => {
    const m = spell();
    expect(m.tick(FIRST_MOVE_MS)).toBe(true);
    expect(m.s.result?.reason).toBe('aborted');
    const t = spell();
    t.act('W', mv('e2e4'), n(t), 0); t.act('B', mv('e7e5'), n(t), 0);
    expect(t.act('W', mv('g1f3'), n(t), 200_000)).toBeNull();
    expect(n(t)).toBe(2);
    expect(t.s.result).toEqual({ winner: 'b', reason: 'timeout' });
    expect(t.ratable).toBe(false);
  });

  it('ends on checkmate and survives being stored and reloaded', () => {
    let m = spell();
    for (const [pid, u] of [['W', 'f2f3'], ['B', 'e7e5'], ['W', 'g2g4']] as const) expect(m.act(pid, mv(u), n(m), 0)).toBeNull();
    m = new Match(JSON.parse(JSON.stringify(m.s)));
    expect(m.turn).toBe('b');
    expect(m.act('B', mv('d8h4'), n(m), 0)).toBeNull();
    expect(m.s.status).toBe('over');
    expect(m.s.result).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(m.act('W', mv('e1f2'), n(m), 0)).toBe('The game is not on.');
    expect(new Match(JSON.parse(JSON.stringify(m.s))).spell!.state.result?.reason).toBe('checkmate');
  });

  it('resign, draw offers and rematch work as in standard chess', () => {
    const m = spell();
    m.act('W', mv('e2e4'), n(m), 0); m.act('B', mv('e7e5'), n(m), 0);
    expect(m.draw('W', 10)).toBeNull();
    expect(m.s.drawOffer).toBe('w');
    m.act('W', mv('g1f3'), n(m), 15);
    expect(m.s.drawOffer).toBe('w');
    m.act('B', mv('g8f6'), n(m), 20); // moving on declines
    expect(m.s.drawOffer).toBeNull();
    expect(m.resign('W', 30)).toBeNull();
    expect(m.s.result).toEqual({ winner: 'b', reason: 'resignation' });
    expect(m.rematch('W')).toBe(false);
    expect(m.rematch('B')).toBe(true);
  });
});
