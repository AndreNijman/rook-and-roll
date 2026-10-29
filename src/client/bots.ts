// The computer opponents. Strong bots are Stockfish with its own strength
// limit (UCI_Elo, which bottoms out at 1320). Weaker ones search shallowly
// for several candidate moves and pick among them with a temperature, so
// they miss tactics the way people do instead of playing perfect chess with
// random blunders thrown in.

import type { Line } from './engine/uci';
import { winPercent } from './engine/uci';
import type { Hair } from './art/portrait';

export interface Bot {
  id: string;
  name: string;
  rating: number;
  blurb: string;
  /** Portrait colours: skin, hair, shirt. */
  look: [string, string, string];
  hair: Hair;
  depth: number;
  multipv: number;
  /** Softmax temperature over win% (0 = always the best line). */
  temperature: number;
  /** Stockfish strength limit, for the strong bots. */
  elo?: number;
  /** Think time in ms, so fast bots still feel like they are thinking. */
  think: number;
}

export const BOTS: Bot[] = [
  { id: 'pip', name: 'Pip', rating: 250, blurb: 'Just learned how the horsey moves.', look: ['#f4c8a0', '#e8a040', '#8ad05a'], hair: 'spiky', depth: 1, multipv: 10, temperature: 30, think: 600 },
  { id: 'moss', name: 'Moss', rating: 500, blurb: 'Likes to grab things. Does not always check if they are poisoned.', look: ['#d8a070', '#5a3a28', '#5ab0d8'], hair: 'short', depth: 2, multipv: 8, temperature: 16, think: 700 },
  { id: 'juniper', name: 'Juniper', rating: 800, blurb: 'Plays the Italian every single time.', look: ['#f0d0b0', '#c84838', '#f0d060'], hair: 'long', depth: 4, multipv: 6, temperature: 9, think: 800 },
  { id: 'rook', name: 'Old Rook', rating: 1100, blurb: 'Retired lighthouse keeper. Patient, slow, solid.', look: ['#e0b090', '#e8e4dc', '#4a6a8a'], hair: 'bald', depth: 6, multipv: 5, temperature: 5, think: 900 },
  { id: 'vesper', name: 'Vesper', rating: 1400, blurb: 'Club regular. Will punish a loose piece.', look: ['#a87050', '#26181e', '#a8405e'], hair: 'hood', depth: 10, multipv: 1, temperature: 0, elo: 1400, think: 900 },
  { id: 'brass', name: 'Brass', rating: 1700, blurb: 'Studies endgames for fun.', look: ['#f0c8a0', '#d4a040', '#3a5a3a'], hair: 'short', depth: 12, multipv: 1, temperature: 0, elo: 1700, think: 1000 },
  { id: 'nyx', name: 'Nyx', rating: 2000, blurb: 'Sharp, aggressive, sacrifices first and asks later.', look: ['#c89070', '#4e3a5e', '#d8484a'], hair: 'spiky', depth: 14, multipv: 1, temperature: 0, elo: 2000, think: 1200 },
  { id: 'grandma', name: 'Grandma Kat', rating: 2400, blurb: 'Was a master before you were born.', look: ['#f0d4c0', '#c8c8d0', '#7a6290'], hair: 'bun', depth: 16, multipv: 1, temperature: 0, elo: 2400, think: 1500 },
  { id: 'storm', name: 'The Storm', rating: 3000, blurb: 'Full strength. Good luck.', look: ['#9ad0f0', '#26181e', '#26181e'], hair: 'hood', depth: 18, multipv: 1, temperature: 0, think: 1500 },
];

export function botOptions(bot: Bot): Record<string, string | number | boolean> {
  return bot.elo
    ? { UCI_LimitStrength: true, UCI_Elo: bot.elo, 'Skill Level': 20 }
    : { UCI_LimitStrength: false, 'Skill Level': 20 };
}

/**
 * The bot's move from the engine's candidate lines. Lines are weighted by
 * how much winning chance they keep, sharpened or flattened by temperature.
 */
export function pickMove(bot: Bot, lines: Line[], bestmove: string, rand: () => number = Math.random): string {
  const usable = lines.filter((l) => l.pv.length);
  if (bot.temperature <= 0 || usable.length < 2) return bestmove || usable[0]?.pv[0] || '';
  const wins = usable.map((l) => winPercent(l.score));
  const top = Math.max(...wins);
  const weights = wins.map((w) => Math.exp((w - top) / bot.temperature));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < usable.length; i++) {
    r -= weights[i];
    if (r <= 0) return usable[i].pv[0];
  }
  return usable[usable.length - 1].pv[0];
}
