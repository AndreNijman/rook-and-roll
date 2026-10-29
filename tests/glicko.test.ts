import { describe, expect, it } from 'vitest';
import { update } from '../src/shared/glicko';

describe('glicko-2', () => {
  it("matches Glickman's worked example", () => {
    const r = update({ rating: 1500, rd: 200, vol: 0.06 }, [
      { opponent: { rating: 1400, rd: 30 }, score: 1 },
      { opponent: { rating: 1550, rd: 100 }, score: 0 },
      { opponent: { rating: 1700, rd: 300 }, score: 0 },
    ], 0.5, false);
    expect(r.rating).toBeCloseTo(1464.06, 1);
    expect(r.rd).toBeCloseTo(151.52, 1);
    expect(r.vol).toBeCloseTo(0.05999, 4);
  });

  it('moves up on a win and down on a loss, and grows uncertainty when idle', () => {
    const me = { rating: 1500, rd: 120, vol: 0.06 };
    const opp = { rating: 1500, rd: 80 };
    expect(update(me, [{ opponent: opp, score: 1 }]).rating).toBeGreaterThan(1500);
    expect(update(me, [{ opponent: opp, score: 0 }]).rating).toBeLessThan(1500);
    expect(update(me, []).rd).toBeGreaterThan(120);
  });

  it('keeps the deviation within bounds', () => {
    let r = { rating: 1500, rd: 50, vol: 0.06 };
    for (let i = 0; i < 200; i++) r = update(r, [{ opponent: { rating: 1500, rd: 50 }, score: 0.5 }]);
    expect(r.rd).toBeGreaterThanOrEqual(45);
  });
});
