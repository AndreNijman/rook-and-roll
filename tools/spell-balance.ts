// Spell Chess balance check: the bot plays itself and reports, per spell, how
// often it is cast once drawn and how much the bot's search thought each cast
// gained (centipawns; 100 is a pawn). The bots blunder into tactics, so the
// absolute numbers run high: compare spells with each other, not with 100.
//
//   npx tsx tools/spell-balance.ts [games=40] [level=1]

import { applyCast, applyMove, discard, endTurn, newGame, type State } from '../src/spell/engine';
import { LEVELS, botAction } from '../src/spell/bot';

const games = Number(process.argv[2] ?? 40);
const level = LEVELS[Number(process.argv[3] ?? 1)];
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

interface Row { drawn: number; held: number; gains: number[] }
const rows: Record<string, Row> = {};
const row = (k: string) => (rows[k] ??= { drawn: 0, held: 0, gains: [] });
const results: Record<string, number> = {};
let plies = 0;

for (let i = 0; i < games; i++) {
  let s: State = newGame(1000 + i);
  for (let steps = 0; !s.result && steps < 1500; steps++) {
    const a = botAction(s, level, rand, (c, gain) => row(c.spell).gains.push(gain));
    const before = s;
    s = a.k === 'move' ? applyMove(s, a.move) : a.k === 'cast' ? applyCast(s, a.cast) : a.k === 'discard' ? discard(s, a.spell) : endTurn(s);
    for (const c of ['w', 'b'] as const) for (const card of s.hands[c]) if (!before.hands[c].includes(card)) row(card).drawn++;
  }
  for (const c of ['w', 'b'] as const) for (const card of s.hands[c]) row(card).held++;
  plies += s.ply;
  const key = s.result ? `${s.result.winner ?? 'draw'} ${s.result.reason}` : 'unfinished';
  results[key] = (results[key] ?? 0) + 1;
}

const q = (a: number[], f: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : 0);
console.log(results, 'avg plies', Math.round(plies / games));
console.log('spell       drawn  cast  use%  median   p25   p75  >=250cp  held at end');
for (const [k, r] of Object.entries(rows).map(([k, r]) => [k, { ...r, gains: r.gains.sort((x, y) => x - y) }] as const).sort((x, y) => q(y[1].gains, 0.5) - q(x[1].gains, 0.5))) {
  const g = r.gains;
  console.log(k.padEnd(11), ...[r.drawn, g.length, Math.round(100 * g.length / Math.max(1, r.drawn)), Math.round(q(g, 0.5)), Math.round(q(g, 0.25)), Math.round(q(g, 0.75))].map((n) => String(n).padStart(5)),
    `${Math.round(100 * g.filter((x) => x >= 250).length / Math.max(1, g.length))}%`.padStart(8), String(r.held).padStart(8));
}
