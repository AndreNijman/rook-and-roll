// Builds the puzzle shards from the Lichess puzzle database (CC0):
//   curl -O https://database.lichess.org/lichess_db_puzzle.csv.zst
//   zstd -dc lichess_db_puzzle.csv.zst | npx tsx tools/puzzles.ts public/puzzles
// Keeps well-tested, well-liked puzzles and samples PER_BUCKET of them from
// every 100-point rating band, with a fixed seed so a rebuild from the same
// database writes the same files. Each shard is a JSON array of
// [id, fen, moves, rating, themes]; index.json lists the bands.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const out = process.argv[2] || 'public/puzzles';
const PER_BUCKET = 200;
const MIN = 400, MAX = 2900;

// Themes worth showing a player; the database has many more.
const THEMES = new Set([
  'mate', 'mateIn1', 'mateIn2', 'mateIn3', 'fork', 'pin', 'skewer', 'hangingPiece', 'sacrifice',
  'discoveredAttack', 'doubleCheck', 'deflection', 'attraction', 'interference', 'clearance',
  'trappedPiece', 'promotion', 'underPromotion', 'enPassant', 'castling', 'zugzwang', 'quietMove',
  'xRayAttack', 'backRankMate', 'smotheredMate', 'endgame', 'opening', 'middlegame',
]);

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = [string, string, string, number, string];
const rand = mulberry32(20261029);
const buckets = new Map<number, { seen: number; rows: Row[] }>();
let read = 0, kept = 0;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (read++ === 0 && line.startsWith('PuzzleId')) continue;
  const [id, fen, moves, rating, rd, popularity, plays, themes] = line.split(',');
  const r = Number(rating);
  if (r < MIN || r >= MAX + 100 || Number(rd) > 90 || Number(popularity) < 90 || Number(plays) < 500) continue;
  kept++;
  const band = Math.min(MAX, Math.floor(r / 100) * 100);
  const b = buckets.get(band) ?? { seen: 0, rows: [] };
  buckets.set(band, b);
  const row: Row = [id, fen, moves, r, themes.split(' ').filter((t) => THEMES.has(t)).join(' ')];
  // Reservoir sampling: every qualifying puzzle in the band is equally likely.
  b.seen++;
  if (b.rows.length < PER_BUCKET) b.rows.push(row);
  else {
    const j = Math.floor(rand() * b.seen);
    if (j < PER_BUCKET) b.rows[j] = row;
  }
}

mkdirSync(out, { recursive: true });
const index: Record<string, number> = {};
for (const [band, b] of [...buckets].sort((x, y) => x[0] - y[0])) {
  b.rows.sort((x, y) => x[3] - y[3]);
  writeFileSync(join(out, `${band}.json`), JSON.stringify(b.rows));
  index[band] = b.rows.length;
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index));
console.log(`read ${read - 1}, qualified ${kept}, wrote ${Object.values(index).reduce((a, n) => a + n, 0)} in ${buckets.size} bands`);
