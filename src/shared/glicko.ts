// Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013). Shared by the
// puzzle trainer in the browser and the online relay. A rating period here is
// one game or one puzzle, as on Lichess.

export interface Rating { rating: number; rd: number; vol: number }
export interface Result { opponent: Pick<Rating, 'rating' | 'rd'>; score: number }

const SCALE = 173.7178;
const EPSILON = 0.000001;

export const DEFAULT: Rating = { rating: 1500, rd: 350, vol: 0.06 };
/** Deviation bounds: a floor so ratings keep moving, the default as a ceiling. */
export const RD_MIN = 45, RD_MAX = 350;

/** A rating counts as settled once its deviation is below this. */
export const provisional = (r: Rating) => r.rd > 110;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

export function update(player: Rating, results: Result[], tau = 0.5, bounds = true): Rating {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  if (!results.length) {
    const rd = Math.sqrt(phi * phi + sigma * sigma) * SCALE;
    return { ...player, rd: bounds ? Math.min(RD_MAX, rd) : rd };
  }

  let vInv = 0, delta = 0;
  for (const { opponent, score } of results) {
    const muJ = (opponent.rating - 1500) / SCALE, phiJ = opponent.rd / SCALE;
    const e = expected(mu, muJ, phiJ), gj = g(phiJ);
    vInv += gj * gj * e * (1 - e);
    delta += gj * (score - e);
  }
  const v = 1 / vInv;
  delta *= v;

  // New volatility by the Illinois algorithm (step 5 of the paper).
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a, B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A), fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPSILON && i < 100; i++) {
    const C = A + ((A - B) * fA) / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  let muNew = mu;
  for (const { opponent, score } of results) {
    const muJ = (opponent.rating - 1500) / SCALE, phiJ = opponent.rd / SCALE;
    muNew += phiNew * phiNew * g(phiJ) * (score - expected(mu, muJ, phiJ));
  }
  const rd = phiNew * SCALE;
  return {
    rating: muNew * SCALE + 1500,
    rd: bounds ? Math.max(RD_MIN, Math.min(RD_MAX, rd)) : rd,
    vol,
  };
}
