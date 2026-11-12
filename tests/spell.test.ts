import { describe, expect, it } from 'vitest';
import {
  SPELL_IDS, applyCast, applyMove, discard, endTurn, fromBoard, godFlick, inCheck, legalCasts, legalMoves, newGame,
  sqIdx, sqName, tryCast, type Cast, type SpellId, type State,
} from '../src/spell/engine';
import { LEVELS, botAction } from '../src/spell/bot';
import { act, replay, sideNow, startGame, takebackPoint, type Act } from '../src/spell/game';

const at = (...names: string[]) => names.map(sqIdx);
const cast = (spell: SpellId, ...names: string[]): Cast => ({ spell, at: at(...names) });
const can = (s: State, spell: SpellId, ...names: string[]) => tryCast(s, cast(spell, ...names)) !== null;
const moveOf = (s: State, uci: string) => legalMoves(s).find((m) => sqName(m.from) + sqName(m.to) === uci.slice(0, 4) && (m.promo ?? '') === uci.slice(4));
const has = (s: State, uci: string) => moveOf(s, uci) !== undefined;
/** Make a move and, if the player is left holding a castable spell, end the turn. */
function mv(s: State, uci: string): State {
  const m = moveOf(s, uci);
  if (!m) throw new Error(`illegal move ${uci}`);
  const n = applyMove(s, m);
  return n.flags.moved && !n.pending && !n.result ? endTurn(n) : n;
}
const fileOfName = (i: number) => sqName(i)[0];
const piece = (s: State, name: string) => s.board[sqIdx(name)];

// Kings on e1 and e8 with room to shuffle, used when a test only needs time to pass.
const QUIET = ['....k...', '........', '........', '........', '........', '........', '........', '....K...'];
const board = (edit: Record<string, string>) => {
  const rows = QUIET.map((r) => r.split(''));
  for (const [sq, ch] of Object.entries(edit)) rows[8 - Number(sq[1])][sq.charCodeAt(0) - 97] = ch;
  return rows.map((r) => r.join(''));
};

describe('spell chess: basics', () => {
  it('plays normal chess from the start position', () => {
    let s = newGame(7);
    expect(legalMoves(s)).toHaveLength(20);
    expect(s.decks.w).toHaveLength(18);
    expect(new Set(s.decks.b).size).toBe(18);
    for (const m of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']) s = mv(s, m);
    expect(has(s, 'e1g1')).toBe(true);
    s = mv(s, 'e1g1');
    expect(piece(s, 'f1')?.t).toBe('r');
    expect(s.castle.w).toEqual({ k: false, q: false });
  });

  it('shuffles the same way for the same seed and survives JSON', () => {
    expect(newGame(3).decks).toEqual(newGame(3).decks);
    expect(newGame(3).decks.w).not.toEqual(newGame(4).decks.w);
    let s = fromBoard(board({ a1: 'R', d5: 'n' }), { hands: { w: ['frost'] } });
    s = applyCast(s, cast('frost', 'c5'));
    const copy = JSON.parse(JSON.stringify(s)) as State;
    expect(copy).toEqual(s);
    expect(legalMoves(copy)).toEqual(legalMoves(s));
  });

  it('draws a card for a capture, en passant included, and none for spell captures', () => {
    let s = fromBoard(board({ d4: 'P', e5: 'p' }));
    s = applyMove(s, moveOf(s, 'd4e5')!);
    expect(s.hands.w).toHaveLength(1);
    expect(s.decks.w).toHaveLength(17);

    let e = fromBoard(board({ e5: 'P', d7: 'p', a7: 'p' }), { turn: 'b' });
    e = mv(e, 'd7d5');
    expect(has(e, 'e5d6')).toBe(true);
    e = applyMove(e, moveOf(e, 'e5d6')!);
    expect(piece(e, 'd5')).toBeNull();
    expect(e.hands.w).toHaveLength(1);
  });

  it('reshuffles everything not in hand when the deck runs out', () => {
    let s = fromBoard(board({ d4: 'P', e5: 'p' }), { hands: { w: ['frost'] } });
    s.decks.w = [];
    s = applyMove(s, moveOf(s, 'd4e5')!);
    expect(s.hands.w).toHaveLength(2);
    expect(s.decks.w).toHaveLength(16);
    expect(s.decks.w).not.toContain('frost');
    expect(new Set([...s.decks.w, ...s.hands.w]).size).toBe(18);
  });

  it('makes you discard one of four when a 4th card is drawn', () => {
    let s = fromBoard(board({ d4: 'P', e5: 'p' }), { hands: { w: ['shapeshift', 'revive', 'surge'] } });
    s = applyMove(s, moveOf(s, 'd4e5')!);
    expect(s.hands.w).toHaveLength(4);
    expect(s.pending).toEqual({ color: 'w' });
    expect(s.turn).toBe('w');
    expect(() => endTurn(s)).toThrow();
    expect(legalCasts(s)).toHaveLength(0);
    const drawn = s.hands.w[3];
    s = discard(s, 'revive');
    expect(s.hands.w).toEqual(['shapeshift', 'surge', drawn]);
    expect(s.pending).toBeNull();
  });

  it('allows one spell a turn, before or after the move', () => {
    let s = fromBoard(board({ a2: 'P', b2: 'P' }), { hands: { w: ['surge', 'charm', 'aegis'] } });
    s = applyCast(s, cast('surge', 'a2'));
    expect(piece(s, 'a3')?.t).toBe('p');
    expect(legalCasts(s)).toHaveLength(0);
    s = applyMove(s, moveOf(s, 'b2b3')!);
    expect(s.turn).toBe('b');

    let t = fromBoard(board({ a2: 'P', b2: 'P' }), { hands: { w: ['surge'] } });
    t = applyMove(t, moveOf(t, 'b2b3')!);
    expect(t.turn).toBe('w');
    expect(legalMoves(t)).toHaveLength(0);
    t = applyCast(t, cast('surge', 'a2'));
    expect(t.turn).toBe('b');
  });

  it('ends the turn by itself when no spell can be cast', () => {
    let s = fromBoard(board({ a2: 'P' }), { hands: { w: ['shapeshift'] } });
    s = applyMove(s, moveOf(s, 'a2a3')!);
    expect(s.turn).toBe('b');
  });
});

describe('spell chess: check rules', () => {
  it('never offers a spell that leaves your own king in check', () => {
    // The e2 bishop is pinned by the e8 rook: no blink may take it off the file.
    const s = fromBoard(['....r..k', '........', '........', '........', '........', '........', 'P...B...', '....K...'], { hands: { w: ['blink', 'shapeshift'] } });
    expect(can(s, 'blink', 'e2', 'd3')).toBe(false);
    expect(can(s, 'shapeshift', 'e2')).toBe(true);
    const casts = legalCasts(s);
    expect(casts.some((c) => c.spell === 'blink' && fileOfName(c.at[1]) !== 'e')).toBe(false);
    expect(casts.some((c) => c.spell === 'blink' && fileOfName(c.at[1]) === 'e')).toBe(true);
  });

  it('forbids a check from a spell before the move, allows it after', () => {
    const s = fromBoard(board({ a2: 'P', c3: 'N' }), { hands: { w: ['blink'] } });
    expect(can(s, 'blink', 'c3', 'd5')).toBe(true);
    // Nc5 -> d6 would check e8.
    const pre = fromBoard(board({ a2: 'P', c5: 'N' }), { hands: { w: ['blink'] } });
    expect(can(pre, 'blink', 'c5', 'd6')).toBe(false);
    const post = applyMove(pre, moveOf(pre, 'a2a3')!);
    expect(post.turn).toBe('w');
    const done = applyCast(post, cast('blink', 'c5', 'd6'));
    expect(done.turn).toBe('b');
    expect(inCheck(done, 'b')).toBe(true);
  });

  it('is not checkmate when a spell is the only way out of check', () => {
    const rows = ['....k...', '........', '........', '........', '........', '........', '......PP', 'r......K'];
    expect(fromBoard(rows).result).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(fromBoard(rows, { hands: { w: ['shapeshift'] } }).result).toEqual({ winner: 'b', reason: 'checkmate' });
    let s = fromBoard(rows, { hands: { w: ['wall'] } });
    expect(s.result).toBeNull();
    expect(legalMoves(s)).toHaveLength(0);
    const outs = legalCasts(s);
    expect(outs.length).toBeGreaterThan(0);
    // Every escape puts a wall tile between the rook and the king.
    expect(outs.every((c) => c.at.some((i) => i > 0 && i < 7))).toBe(true);
    s = applyCast(s, cast('wall', 'b1', 'c1'));
    expect(inCheck(s, 'w')).toBe(false);
    expect(legalMoves(s).length).toBeGreaterThan(0);
  });

  it('is stalemate unless a spell creates a legal move', () => {
    const rows = ['....k...', '........', '........', '........', '........', '.q......', '........', 'K.......'];
    expect(fromBoard(rows, { hands: { w: ['revive'] } }).result).toEqual({ winner: null, reason: 'stalemate' });
    let s = fromBoard(rows, { hands: { w: ['revive'] }, lost: { w: 1 } });
    expect(s.result).toBeNull();
    s = applyCast(s, cast('revive', 'h2'));
    expect(legalMoves(s).map((m) => sqName(m.from))).toEqual(['h2', 'h2']);
  });

  it('never lets a spell touch a king', () => {
    const s = fromBoard(board({ d7: 'N', a2: 'P' }), { hands: { w: ['gust', 'frost', 'aegis'] } });
    expect(can(s, 'gust', 'e8', 'f8')).toBe(false);
    expect(can(s, 'aegis', 'e1')).toBe(false);
    expect(can(s, 'frost', 'd7')).toBe(false); // only the king is in the block
  });
});

describe('spell chess: the spells', () => {
  it('Frost Nova freezes for one enemy turn; frozen pieces still attack', () => {
    let s = fromBoard(board({ a1: 'R', d5: 'n' }), { hands: { w: ['frost'] } });
    expect(can(s, 'frost', 'a2')).toBe(false); // nothing to freeze
    expect(can(s, 'frost', 'h5')).toBe(false); // off the board
    s = applyCast(s, cast('frost', 'c5'));
    s = mv(s, 'a1a2');
    expect(legalMoves(s).every((m) => sqName(m.from) === 'e8')).toBe(true);
    s = mv(s, 'e8e7');
    s = mv(s, 'a2a1');
    expect(legalMoves(s).some((m) => sqName(m.from) === 'd5')).toBe(true);

    // A frozen queen still pins: f2 may not step away from the h4-e1 diagonal.
    let p = fromBoard(board({ f2: 'P', h4: 'q', a2: 'P' }), { hands: { w: ['frost'] } });
    p = applyCast(p, cast('frost', 'g3'));
    expect(has(p, 'f2f3')).toBe(false);
    expect(has(p, 'a2a3')).toBe(true);
  });

  it('Phantom Knight: own half, no check, waits a turn, lasts three turns, one at a time', () => {
    let s = fromBoard(board({ a2: 'P' }), { hands: { w: ['phantom', 'echo'] } });
    expect(can(s, 'phantom', 'd5')).toBe(false);
    expect(can(s, 'phantom', 'a2')).toBe(false);
    s = applyCast(s, cast('phantom', 'd4'));
    expect(piece(s, 'd4')).toMatchObject({ t: 'n', c: 'w', ghost: true });
    expect(legalMoves(s).some((m) => sqName(m.from) === 'd4')).toBe(false);
    s = mv(s, 'a2a3');
    s = mv(s, 'e8d8');
    expect(has(s, 'd4f5')).toBe(true);
    s = mv(s, 'a3a4'); s = mv(s, 'd8e8'); // caster's 1st turn after casting
    s = mv(s, 'a4a5'); s = mv(s, 'e8d8'); // 2nd
    expect(piece(s, 'd4')?.ghost).toBe(true);
    s = mv(s, 'a5a6'); // 3rd: gone when it ends
    expect(piece(s, 'd4')).toBeNull();
    expect(s.fx.phantoms).toHaveLength(0);

    const chk = fromBoard(['....k...', '........', '........', '........', '........', '........', '........', '....K...'], { turn: 'b', hands: { b: ['phantom'] } });
    expect(can(chk, 'phantom', 'd6')).toBe(true);
    const near = fromBoard(board({ e1: '.', e4: 'K' }), { turn: 'b', hands: { b: ['phantom'] } });
    expect(can(near, 'phantom', 'd6')).toBe(false); // would check e4
    const two = fromBoard(board({ a2: 'P' }), { hands: { w: ['phantom'] } });
    two.fx.phantoms.push({ by: 'w', id: 99, placed: 0, until: 9 });
    expect(legalCasts(two)).toHaveLength(0);
  });

  it('Phantom Knight captures draw a card; capturing it draws none', () => {
    let s = fromBoard(board({ a2: 'P', a7: 'p', f5: 'p', e6: 'p' }), { hands: { w: ['phantom'] } });
    s = applyCast(s, cast('phantom', 'd4'));
    s = mv(s, 'a2a3'); s = mv(s, 'a7a6');
    s = mv(s, 'd4f5');
    expect(s.hands.w).toHaveLength(1);
    s = mv(s, 'e6f5');
    expect(s.hands.b).toHaveLength(0);
    expect(s.lost.w).toBe(0);
    expect(s.fx.phantoms).toHaveLength(0);
  });

  it('Royal Alarm forces a king move, without castling', () => {
    let s = fromBoard(['r...k..r', 'p.......', '........', '........', '........', '........', 'P.......', '....K...'], { castle: 'kq', hands: { w: ['alarm'] } });
    s = applyCast(s, cast('alarm'));
    s = mv(s, 'a2a3');
    const moves = legalMoves(s);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => sqName(m.from) === 'e8' && m.kind !== 'castle')).toBe(true);
    s = mv(s, 'e8e7'); s = mv(s, 'a3a4');
    expect(has(s, 'a7a6')).toBe(true); // one move only
  });

  it('Royal Alarm lets a piece that is under attack get away', () => {
    // White attacks the b4 knight with a pawn and sounds the alarm: the knight may still run.
    let s = fromBoard(board({ a2: 'P', h2: 'P', b4: 'n', g8: 'n', h7: 'p' }), { hands: { w: ['alarm'] } });
    s = applyCast(s, cast('alarm'));
    s = mv(s, 'a2a3');
    const from = new Set(legalMoves(s).map((m) => sqName(m.from)));
    expect([...from].sort()).toEqual(['b4', 'e8']);
    expect(has(s, 'g8f6')).toBe(false);
    expect(has(s, 'h7h6')).toBe(false);
    expect(has(s, 'b4d5')).toBe(true);
  });

  it('Royal Alarm needs a king move now, and fizzles if there is none later', () => {
    const boxed = fromBoard(['...qkb..', '...ppp..', '........', '........', '........', '........', 'P.......', '....K...'], { hands: { w: ['alarm'] } });
    expect(can(boxed, 'alarm')).toBe(false);

    let s = fromBoard(['.......k', 'p......p', '........', '........', '........', '.R......', '........', '....K...'], { hands: { w: ['alarm'] } });
    s = applyCast(s, cast('alarm'));
    s = mv(s, 'b3g3'); // takes g7 and g8 away
    expect(s.result).toBeNull();
    expect(has(s, 'a7a6')).toBe(true);
    expect(legalMoves(s).some((m) => sqName(m.from) === 'h8')).toBe(false);
  });

  it('Royal Alarm: no spell may leave the alarmed king without a move', () => {
    // Black's king can only go to d8; a wall there would strand it.
    let s = fromBoard(['....k...', '....pp..', '........', '........', '........', '........', 'P.......', '...RK...'].map((r, i) => (i === 7 ? '..R.K...' : r)), { hands: { w: ['alarm'], b: ['wall'] } });
    s = applyCast(s, cast('alarm'));
    s = mv(s, 'a2a3');
    expect(legalMoves(s).map((m) => sqName(m.to)).sort()).toEqual(['d7', 'd8', 'f8']);
    expect(can(s, 'wall', 'a5', 'a6')).toBe(true);
    expect(can(s, 'wall', 'd7', 'd8')).toBe(true); // f8 is left
    s.fx.walls.push({ by: 'w', a: sqIdx('f8'), b: sqIdx('g8'), until: 99 });
    expect(can(s, 'wall', 'd7', 'd8')).toBe(false);
  });

  it('Transpose swaps two of your pieces, never a pawn onto a back rank', () => {
    let s = fromBoard(board({ a1: 'R', a2: 'P', h5: 'N' }), { castle: 'Q', hands: { w: ['transpose'] } });
    expect(can(s, 'transpose', 'a1', 'a2')).toBe(false);
    expect(can(s, 'transpose', 'e1', 'a1')).toBe(false);
    expect(can(s, 'transpose', 'a2', 'e8')).toBe(false);
    s = applyCast(s, cast('transpose', 'a1', 'h5'));
    expect(piece(s, 'a1')?.t).toBe('n');
    expect(piece(s, 'h5')?.t).toBe('r');
    expect(s.castle.w.q).toBe(false);
  });

  it('Blink teleports within two squares; the piece then sits the move out', () => {
    let s = fromBoard(board({ a1: 'R', a2: 'P', d3: 'p', c1: 'Q' }), { castle: 'Q', hands: { w: ['blink'] } });
    expect(can(s, 'blink', 'a1', 'a4')).toBe(false); // too far
    expect(can(s, 'blink', 'a1', 'a2')).toBe(false); // occupied
    expect(can(s, 'blink', 'c1', 'c3')).toBe(false); // no queens
    expect(can(s, 'blink', 'a1', 'c3')).toBe(true); // through pieces is fine
    s = applyCast(s, cast('blink', 'a1', 'b3'));
    expect(piece(s, 'b3')?.t).toBe('r');
    expect(s.castle.w.q).toBe(false);
    expect(legalMoves(s).some((m) => sqName(m.from) === 'b3')).toBe(false);
    s = mv(s, 'a2a3'); s = mv(s, 'e8e7');
    expect(has(s, 'b3d3')).toBe(true);
  });

  it('Stone Wall blocks everything but a knight jump until your second turn', () => {
    let s = fromBoard(board({ a1: 'R', b1: 'N', h2: 'P', h7: 'p' }), { hands: { w: ['wall'] } });
    expect(can(s, 'wall', 'a3', 'b4')).toBe(false);
    expect(can(s, 'wall', 'h3', 'a4')).toBe(false); // wraps the edge
    expect(can(s, 'wall', 'a1', 'a2')).toBe(false);
    s = applyCast(s, cast('wall', 'a3', 'b3'));
    expect(has(s, 'a1a2')).toBe(true);
    expect(has(s, 'a1a3')).toBe(false);
    expect(has(s, 'a1a4')).toBe(false);
    expect(has(s, 'b1a3')).toBe(false);
    expect(has(s, 'b1c3')).toBe(true);
    s = mv(s, 'h2h3'); s = mv(s, 'h7h6');
    expect(has(s, 'a1a4')).toBe(false); // first turn after casting: still up
    s = mv(s, 'h3h4'); s = mv(s, 'h6h5');
    expect(s.fx.walls).toHaveLength(0);
    expect(has(s, 'a1a4')).toBe(true);
  });

  it('Stone Wall stops castling through it and blocks checks', () => {
    const s = fromBoard(['....k...', '........', '........', '........', '........', '........', '........', 'R...K..R'], { castle: 'KQ' });
    expect(has(s, 'e1g1')).toBe(true);
    s.fx.walls.push({ by: 'b', a: sqIdx('f1'), b: sqIdx('f2'), until: 99 });
    expect(has(s, 'e1g1')).toBe(false);
    expect(has(s, 'e1c1')).toBe(true);
  });

  it('Aegis protects from moves and spells until your next turn', () => {
    let s = fromBoard(board({ d4: 'P', a2: 'P', e5: 'p', c5: 'p' }), { hands: { w: ['aegis'], b: ['smite'] } });
    s = applyCast(s, cast('aegis', 'd4'));
    s = mv(s, 'a2a3');
    expect(has(s, 'e5d4')).toBe(false);
    expect(can(s, 'smite', 'd4')).toBe(false);
    expect(can(s, 'smite', 'a3')).toBe(false); // not next to a black piece
    s = mv(s, 'e8e7');
    expect(s.fx.aegis).toHaveLength(0);
    s = mv(s, 'a3a4');
    expect(has(s, 'e5d4')).toBe(true);
  });

  it('Surge pushes your pawn one square, never to the last rank or onto a piece', () => {
    let s = fromBoard(board({ a2: 'P', b7: 'P', c4: 'P', c5: 'p' }), { hands: { w: ['surge'] } });
    expect(can(s, 'surge', 'b7')).toBe(false);
    expect(can(s, 'surge', 'c4')).toBe(false);
    s = applyCast(s, cast('surge', 'a2'));
    expect(piece(s, 'a3')?.t).toBe('p');
    expect(s.ep).toBe(-1);
    expect(has(s, 'a3a5')).toBe(false);
  });

  it('Shapeshift turns a knight into a bishop and back', () => {
    let s = fromBoard(board({ b1: 'N', c1: 'B', a1: 'R' }), { hands: { w: ['shapeshift'] } });
    expect(can(s, 'shapeshift', 'a1')).toBe(false);
    expect(can(s, 'shapeshift', 'c1')).toBe(true);
    s = applyCast(s, cast('shapeshift', 'b1'));
    expect(piece(s, 'b1')?.t).toBe('b');
    expect(has(s, 'b1e4')).toBe(true);
  });

  it('Revive needs a lost pawn and an empty square on your second rank', () => {
    const none = fromBoard(board({ a2: 'P' }), { hands: { w: ['revive'] } });
    expect(legalCasts(none)).toHaveLength(0);
    let s = fromBoard(board({ a2: 'P', d5: 'P', e6: 'p' }), { turn: 'b', hands: { w: ['revive'] } });
    s = mv(s, 'e6d5');
    expect(s.lost.w).toBe(1);
    expect(can(s, 'revive', 'a2')).toBe(false);
    expect(can(s, 'revive', 'b3')).toBe(false);
    s = applyCast(s, cast('revive', 'b2'));
    expect(s.lost.w).toBe(0);
    expect(has(s, 'b2b4')).toBe(true);
    expect(tryCast(s, cast('revive', 'c2'))).toBeNull();
  });

  it('Gust pushes an enemy piece away from yours', () => {
    let s = fromBoard(board({ d4: 'N', d5: 'n', d6: '.', a7: 'P', b8: 'p', g7: 'p', g6: 'R' }), { hands: { w: ['gust'] } });
    expect(can(s, 'gust', 'd5', 'e5')).toBe(false); // no white piece on c5
    expect(can(s, 'gust', 'g7', 'g8')).toBe(false); // pawn onto a back rank
    expect(can(s, 'gust', 'b8', 'c8')).toBe(false); // no pusher behind it
    s = applyCast(s, cast('gust', 'd5', 'd6'));
    expect(piece(s, 'd6')?.t).toBe('n');
    expect(piece(s, 'd5')).toBeNull();
    const blocked = fromBoard(board({ d4: 'N', d5: 'n', d6: 'p' }), { hands: { w: ['gust'] } });
    expect(can(blocked, 'gust', 'd5', 'd6')).toBe(false);
    const walled = fromBoard(board({ d4: 'N', d5: 'n' }), { hands: { w: ['gust'] } });
    walled.fx.walls.push({ by: 'b', a: sqIdx('d6'), b: sqIdx('e6'), until: 99 });
    expect(can(walled, 'gust', 'd5', 'd6')).toBe(false);
  });

  it('Gust onto a Rune Trap destroys the piece, with no card and a reset clock', () => {
    let s = fromBoard(board({ d4: 'N', d5: 'n', a2: 'P' }), { hands: { w: ['gust'] } });
    s.fx.traps.push({ by: 'w', sq: sqIdx('d6'), until: 99 });
    s.half = 30;
    s = applyCast(s, cast('gust', 'd5', 'd6'));
    expect(piece(s, 'd6')).toBeNull();
    expect(s.fx.traps).toHaveLength(0);
    expect(s.hands.w).toHaveLength(0);
    expect(s.half).toBe(0);
  });

  it('Time Slip undoes a plain enemy move and lets a pawn double-step again', () => {
    let s = fromBoard(board({ a2: 'P', d7: 'p', b8: 'n' }), { turn: 'b', hands: { w: ['timeslip'] } });
    s = mv(s, 'd7d5');
    s = applyCast(s, cast('timeslip'));
    expect(piece(s, 'd7')?.t).toBe('p');
    expect(piece(s, 'd5')).toBeNull();
    s = mv(s, 'a2a3');
    expect(has(s, 'd7d5')).toBe(true);

    let k = fromBoard(board({ a2: 'P' }), { turn: 'b', hands: { w: ['timeslip'] } });
    k = mv(k, 'e8e7');
    expect(can(k, 'timeslip')).toBe(false); // king move
    let c = fromBoard(board({ a2: 'P', d5: 'P', e6: 'p' }), { turn: 'b', hands: { w: ['timeslip'] } });
    c = mv(c, 'e6d5');
    expect(can(c, 'timeslip')).toBe(false); // capture
    const first = fromBoard(board({ a2: 'P' }), { hands: { w: ['timeslip'] } });
    expect(can(first, 'timeslip')).toBe(false); // nothing to undo
  });

  it('Rune Trap destroys the first enemy piece to land on it, and expires', () => {
    let s = fromBoard(board({ a2: 'P', b1: 'N', b8: 'n', h7: 'p' }), { hands: { w: ['trap', 'echo'] } });
    expect(can(s, 'trap', 'a2')).toBe(false);
    s = applyCast(s, cast('trap', 'c6'));
    s = mv(s, 'b1c3');
    s = mv(s, 'b8c6');
    expect(piece(s, 'c6')).toBeNull();
    expect(s.fx.traps).toHaveLength(0);
    expect(s.hands.w).toHaveLength(1); // no card for the trap

    let own = fromBoard(board({ a2: 'P', h7: 'p' }), { hands: { w: ['trap'] } });
    own = applyCast(own, cast('trap', 'a3'));
    expect(tryCast(own, cast('trap', 'a4'))).toBeNull();
    own = mv(own, 'a2a3');
    expect(piece(own, 'a3')?.t).toBe('p'); // own piece is safe
    expect(own.fx.traps).toHaveLength(1);
    own = mv(own, 'h7h6');
    own = mv(own, 'e1d1'); own = mv(own, 'h6h5');
    own = mv(own, 'd1e1'); own = mv(own, 'h5h4');
    expect(own.fx.traps).toHaveLength(1);
    own = mv(own, 'e1d1'); // third turn after casting ends
    expect(own.fx.traps).toHaveLength(0);

    const one = fromBoard(board({ a2: 'P' }), { hands: { w: ['trap'] } });
    one.fx.traps.push({ by: 'w', sq: 30, until: 99 });
    expect(legalCasts(one)).toHaveLength(0);
  });

  it('Rune Trap covers two adjacent squares and is spent by the first piece caught', () => {
    let s = fromBoard(board({ a2: 'P', b8: 'n', g8: 'n', h7: 'p' }), { hands: { w: ['trap'] } });
    expect(can(s, 'trap', 'c6', 'd5')).toBe(false); // not adjacent
    expect(can(s, 'trap', 'h5', 'a6')).toBe(false); // wraps the edge
    expect(can(s, 'trap', 'c6', 'b8')).toBe(false);
    expect(legalCasts(s).every((c) => c.at.length === 2)).toBe(true);
    s = applyCast(s, cast('trap', 'c6', 'd6'));
    expect(s.fx.traps).toEqual([{ by: 'w', sq: sqIdx('c6'), sq2: sqIdx('d6'), until: 7 }]);
    s = mv(s, 'a2a3');
    s = mv(s, 'b8c6');
    expect(piece(s, 'c6')).toBeNull();
    expect(s.fx.traps).toHaveLength(0); // both squares are safe again
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('a king walks over a trap unharmed', () => {
    let s = fromBoard(board({ a2: 'P' }), { turn: 'b' });
    s.fx.traps.push({ by: 'w', sq: sqIdx('e7'), until: 99 });
    s = mv(s, 'e8e7');
    expect(piece(s, 'e7')?.t).toBe('k');
    expect(s.fx.traps).toHaveLength(1);
  });

  it('Smite destroys an adjacent enemy pawn, with no card', () => {
    let s = fromBoard(board({ d4: 'N', e5: 'p', h7: 'p', a2: 'P', d6: 'n' }), { hands: { w: ['smite'] } });
    s.half = 12;
    expect(can(s, 'smite', 'h7')).toBe(false);
    expect(can(s, 'smite', 'd6')).toBe(false); // pawns only
    s = applyCast(s, cast('smite', 'e5'));
    expect(piece(s, 'e5')).toBeNull();
    expect(s.hands.w).toHaveLength(0);
    expect(s.lost.b).toBe(1);
    expect(s.half).toBe(0);
  });

  it('Leap lets a rook or bishop jump exactly one piece on this move', () => {
    let s = fromBoard(board({ a1: 'R', a2: 'P', a5: 'p', a7: 'p', d1: 'Q', d2: 'P' }), { hands: { w: ['leap'] } });
    expect(has(s, 'a1a3')).toBe(false);
    s = applyCast(s, cast('leap'));
    expect(has(s, 'a1a3')).toBe(true);
    expect(has(s, 'a1a4')).toBe(true);
    expect(has(s, 'a1a5')).toBe(true); // capture after the jump
    expect(has(s, 'a1a6')).toBe(false); // not over two
    expect(has(s, 'd1d3')).toBe(false); // no queens
    s = applyMove(s, moveOf(s, 'a1a5')!);
    expect(s.hands.w).toHaveLength(1);
    expect(s.flags.leap).toBe(false);

    const wall = fromBoard(board({ a1: 'R', h2: 'P' }), { hands: { w: ['leap'] } });
    wall.fx.walls.push({ by: 'b', a: sqIdx('a2'), b: sqIdx('b2'), until: 99 });
    wall.fx.walls.push({ by: 'b', a: sqIdx('b1'), b: sqIdx('c1'), until: 99 });
    expect(can(wall, 'leap')).toBe(false); // nothing to jump
    const after = applyMove(fromBoard(board({ a1: 'R', a2: 'P', h2: 'P' }), { hands: { w: ['leap'] } }), { from: sqIdx('h2'), to: sqIdx('h3'), kind: 'n' });
    expect(after.turn).toBe('b'); // Leap is only castable before the move
  });

  it('Charm pushes an enemy pawn one square forward', () => {
    let s = fromBoard(board({ a2: 'P', d7: 'p', h2: 'p', c4: 'p', c3: 'P' }), { hands: { w: ['charm'] } });
    expect(can(s, 'charm', 'h2')).toBe(false); // promotion rank
    expect(can(s, 'charm', 'c4')).toBe(false); // blocked
    s = applyCast(s, cast('charm', 'd7'));
    expect(piece(s, 'd6')?.t).toBe('p');
    s = mv(s, 'a2a3');
    expect(has(s, 'd6d4')).toBe(false);
  });

  it('Silence blocks spells for a turn and ends the enemy effects', () => {
    let s = fromBoard(board({ a2: 'P', d4: 'N', h7: 'p', g8: 'n' }), { hands: { w: ['silence'], b: ['surge'] } });
    const ghost = { t: 'n', c: 'b', id: 500, ghost: true } as const;
    s.board[sqIdx('c6')] = ghost;
    s.fx.phantoms.push({ by: 'b', id: 500, placed: -1, until: 9 });
    s.fx.walls.push({ by: 'b', a: 16, b: 17, until: 9 }, { by: 'w', a: 40, b: 41, until: 9 });
    s.fx.traps.push({ by: 'b', sq: 20, until: 9 });
    s.fx.aegis.push({ by: 'b', id: s.board[sqIdx('g8')]!.id, until: 9 });
    s.fx.frost.push({ by: 'b', ids: [s.board[sqIdx('d4')]!.id], until: 9 });
    expect(legalMoves(s).some((m) => sqName(m.from) === 'd4')).toBe(false);
    s = applyCast(s, cast('silence'));
    expect(piece(s, 'c6')).toBeNull();
    expect(s.fx.walls).toEqual([{ by: 'w', a: 40, b: 41, until: 9 }]);
    expect([s.fx.traps, s.fx.aegis, s.fx.frost, s.fx.phantoms].every((x) => x.length === 0)).toBe(true);
    expect(has(s, 'd4f5')).toBe(true);
    s = mv(s, 'a2a3');
    expect(legalCasts(s)).toHaveLength(0);
    s = mv(s, 'h7h6'); s = mv(s, 'a3a4');
    expect(legalCasts(s).length).toBeGreaterThan(0);
  });

  it('Echo copies the last enemy spell, and an Echo of an Echo', () => {
    let s = fromBoard(board({ a2: 'P', b2: 'P', h7: 'p', g7: 'p' }), { hands: { w: ['surge', 'echo'], b: ['echo'] } });
    const fresh = fromBoard(board({ a2: 'P', h7: 'p' }), { hands: { w: ['echo'] } });
    expect(legalCasts(fresh)).toHaveLength(0);
    s = applyCast(s, cast('surge', 'a2'));
    s = mv(s, 'b2b3');
    expect(tryCast(s, { spell: 'echo', at: at('h7'), as: 'charm' })).toBeNull();
    s = applyCast(s, { spell: 'echo', at: at('h7'), as: 'surge' });
    expect(piece(s, 'h6')?.t).toBe('p');
    expect(s.lastCast.b).toBe('surge');
    s = mv(s, 'g7g6');
    expect(legalCasts(s).every((c) => c.spell === 'echo' && c.as === 'surge')).toBe(true);
    s = applyCast(s, { spell: 'echo', at: at('b3'), as: 'surge' });
    expect(piece(s, 'b4')?.t).toBe('p');
  });

  it('Echo is not castable when the copied spell has no legal target', () => {
    const s = fromBoard(board({ a2: 'N', h7: 'p' }), { hands: { w: ['echo'] } });
    s.lastCast.b = 'surge'; // White has no pawn to surge
    expect(legalCasts(s)).toHaveLength(0);
  });
});

describe('spell chess: other systems', () => {
  it('draws by repetition and by the fifty-move rule', () => {
    let s = fromBoard(board({ a1: 'R', a8: 'r' }));
    for (let i = 0; i < 2 && !s.result; i++) for (const m of ['a1b1', 'a8b8', 'b1a1', 'b8a8']) s = mv(s, m);
    expect(s.result).toEqual({ winner: null, reason: 'repetition' });
    let f = fromBoard(board({ a1: 'R', a8: 'r' }));
    f.half = 99;
    f = mv(f, 'a1b1');
    expect(f.result).toEqual({ winner: null, reason: 'fifty-move rule' });
  });

  it('god powers change the state like any other action', () => {
    const s = fromBoard(board({ a2: 'P', d8: 'q' }));
    const g = godFlick(s, sqIdx('d8'));
    expect(piece(g, 'd8')).toBeNull();
    expect(piece(s, 'd8')?.t).toBe('q');
    expect(godFlick(s, sqIdx('e8')).result).toEqual({ winner: 'w', reason: 'divine intervention' });
  });

  it('the bot takes a free queen and plays whole turns to the end of a game', () => {
    const s = fromBoard(board({ d1: 'R', d8: 'q', a2: 'P', h7: 'p' }), { hands: { w: ['aegis'] } });
    // It shields the rook first, so the king cannot take back on d8.
    const pre = botAction(s, LEVELS[1], () => 0.5);
    expect(pre).toEqual({ k: 'cast', cast: { spell: 'aegis', at: at('d1') } });
    const act = botAction(applyCast(s, cast('aegis', 'd1')), LEVELS[1], () => 0.5);
    expect(act.k === 'move' && sqName(act.move.from) + sqName(act.move.to)).toBe('d1d8');

    // Smite is plainly worth a pawn here: the bot casts it rather than hold it.
    const m = fromBoard(board({ d4: 'N', e5: 'p', a2: 'P', a7: 'p' }), { hands: { w: ['smite'] } });
    const first = botAction(m, LEVELS[1], () => 0.99);
    const then = first.k === 'move' ? botAction(applyMove(m, first.move), LEVELS[1], () => 0.99) : first;
    expect(then.k === 'cast' && then.cast.spell).toBe('smite');

    let g = newGame(11);
    let casts = 0, steps = 0;
    const rand = (() => { let x = 5; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();
    while (!g.result && steps++ < 400) {
      const a = botAction(g, LEVELS[0], rand);
      if (a.k === 'cast') casts++;
      g = a.k === 'move' ? applyMove(g, a.move) : a.k === 'cast' ? applyCast(g, a.cast) : a.k === 'discard' ? discard(g, a.spell) : endTurn(g);
      expect(g.hands.w.length).toBeLessThanOrEqual(4);
      for (const c of ['w', 'b'] as const) expect(new Set([...g.decks[c], ...g.hands[c]]).size).toBe(g.decks[c].length + g.hands[c].length);
    }
    expect(steps).toBeGreaterThan(20);
    expect(casts).toBeGreaterThan(0);
    for (const id of SPELL_IDS) expect(typeof id).toBe('string');
  });
});

describe('spell chess: the game record', () => {
  const m = (uci: string): Act => ({ k: 'm', from: sqIdx(uci.slice(0, 2)), to: sqIdx(uci.slice(2, 4)) });
  /** The actions for a line of moves, ending each turn that waits on a spell. */
  function line(seed: number, ucis: string[]): Act[] {
    const acts: Act[] = [];
    for (const u of ucis) {
      acts.push(m(u));
      if (replay(seed, acts).state.flags.moved) acts.push({ k: 'e' });
    }
    return acts;
  }
  const opening = line(9, ['e2e4', 'd7d5', 'e4d5', 'd8d5']);

  it('replays to the same state, hands and log from a seed and actions', () => {
    const a = replay(9, opening), b = replay(9, opening);
    expect(a.state).toEqual(b.state);
    expect(a.state.turn).toBe('w');
    expect(a.state.hands.w).toHaveLength(1);
    expect(a.state.hands.b).toHaveLength(1);
    expect(a.log.map((l) => l.text.replace(/draws .*/, 'draws'))).toEqual(['White: e2-e4', 'Black: d7-d5', 'White: e4xd5', 'White draws', 'Black: Qd8xd5', 'Black draws']);
    expect(replay(9, JSON.parse(JSON.stringify(opening)) as Act[]).state).toEqual(a.state);
    expect(replay(10, opening).state.hands).not.toEqual(a.state.hands);
  });

  it('waits for "cast or end turn" after a move while a spell is castable', () => {
    const acts = [m('e2e4'), m('d7d5'), m('e4d5')];
    const g = replay(9, acts);
    expect(g.state.hands.w).toEqual(['frost']);
    expect(g.state.turn).toBe('w');
    expect(g.state.flags.moved).toBe(true);
    expect(act(g, m('d8d5'))).toBeNull();
    expect(act(g, { k: 'e' })!.state.turn).toBe('b');
  });

  it('refuses illegal actions and logs spells in words', () => {
    const g = startGame(9);
    expect(act(g, m('e2e5'))).toBeNull();
    expect(act(g, { k: 'e' })).toBeNull();
    expect(act(g, { k: 'c', cast: { spell: 'smite', at: [sqIdx('e7')] } })).toBeNull();
    const wished = act(g, { k: 'g', p: 'wish', spell: 'surge', c: 'w' })!;
    const cast = act(wished, { k: 'c', cast: { spell: 'surge', at: [sqIdx('e2')] } })!;
    expect(cast.log[cast.log.length - 1].text).toBe('White casts Surge: e2');
    expect(cast.state.board[sqIdx('e3')]?.t).toBe('p');
  });

  it('takes back to the start of your last turn, spells and draws included', () => {
    const acts = [...opening, m('b1c3')];
    const k = takebackPoint(9, acts, 'w');
    expect(k).toBe(opening.length);
    expect(replay(9, acts.slice(0, k)).state).toEqual(replay(9, opening).state);
    // Black's last turn started after White's e4xd5 and "end turn".
    const kb = takebackPoint(9, acts, 'b');
    const back = replay(9, acts.slice(0, kb)).state;
    expect([back.turn, back.hands.b.length, back.board[sqIdx('d8')]?.t]).toEqual(['b', 0, 'q']);
    expect(takebackPoint(9, [], 'w')).toBe(-1);
    expect(takebackPoint(9, [m('e2e4')], 'b')).toBe(-1);
    expect(takebackPoint(9, [m('e2e4'), m('e7e5')], 'both')).toBe(1);
  });

  it('god powers are recorded, replayed, and swap which side you hold', () => {
    const acts: Act[] = [m('e2e4'), m('e7e5'), { k: 'g', p: 'flick', sq: sqIdx('d8') }, { k: 'g', p: 'swap' }, { k: 'g', p: 'anoint', sq: sqIdx('a2') }];
    const g = replay(3, acts);
    expect(g.state.board[sqIdx('d8')]).toBeNull();
    expect(g.state.board[sqIdx('a2')]?.t).toBe('q');
    expect(sideNow(g, 'w')).toBe('b');
    expect(g.log.filter((l) => l.kind === 'god')).toHaveLength(3);
    const passed = act(g, { k: 'g', p: 'pass' })!;
    expect(passed.state.turn).toBe('b');
    const demoted = act(g, { k: 'g', p: 'chicken', sq: sqIdx('a2') })!;
    expect(demoted.state.board[sqIdx('a2')]?.t).toBe('p');
    expect(act(g, { k: 'g', p: 'chicken', sq: sqIdx('e8') })).toBeNull();
  });
});
