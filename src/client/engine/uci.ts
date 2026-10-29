// UCI output parsing and score maths. Pure, so the tests and the review can
// use it without a browser or an engine.

/** A score from the side to move's point of view: centipawns or mate in N. */
export interface Score { cp?: number; mate?: number }

export interface Line {
  multipv: number;
  depth: number;
  score: Score;
  /** Principal variation in UCI notation (e2e4, e7e8q). */
  pv: string[];
}

export function parseInfo(text: string): Line | null {
  if (!text.startsWith('info ') || !text.includes(' pv ') || !text.includes(' score ')) return null;
  const tok = text.split(/\s+/);
  const line: Line = { multipv: 1, depth: 0, score: {}, pv: [] };
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    if (t === 'depth') line.depth = Number(tok[++i]);
    else if (t === 'multipv') line.multipv = Number(tok[++i]);
    else if (t === 'score') {
      const kind = tok[++i], value = Number(tok[++i]);
      if (kind === 'cp') line.score = { cp: value };
      else if (kind === 'mate') line.score = { mate: value };
      // Bounds are fail-high/low guesses mid-search, not real scores.
      if (tok[i + 1] === 'lowerbound' || tok[i + 1] === 'upperbound') return null;
    } else if (t === 'pv') { line.pv = tok.slice(i + 1); break; }
  }
  return line.pv.length ? line : null;
}

export const flip = (s: Score): Score => (s.mate !== undefined ? { mate: -s.mate } : { cp: -(s.cp ?? 0) });

/**
 * Win chance for the side the score belongs to, 0-100, using Lichess's
 * logistic fit of centipawns to game results. Mates are certain.
 */
export function winPercent(s: Score): number {
  if (s.mate !== undefined) return s.mate > 0 ? 100 : s.mate < 0 ? 0 : 50;
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** "+1.4", "-0.3", "M3", "-M2" for display; from white's point of view. */
export function formatScore(s: Score): string {
  if (s.mate !== undefined) return `${s.mate < 0 ? '-' : ''}M${Math.abs(s.mate)}`;
  const v = (s.cp ?? 0) / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}
