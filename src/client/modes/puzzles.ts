// Rated puzzles and Puzzle Rush. Rated puzzles move a Glicko-2 rating once
// per puzzle: a clean solve is a win against the puzzle's rating, and a wrong
// move, a hint or a peek at the solution is a loss. Rush is three minutes and
// three strikes, starting easy and getting harder with every solve.

import { Chess, type Move, type Square } from 'chess.js';
import { getProfile, saveProfile } from '../account';
import type { PieceType } from '../art/pieces';
import { play as sound } from '../audio';
import { BoardView } from '../board/view';
import { boardState, parseUci, soundFor } from '../game';
import { PuzzleRun, THEME_NAMES, pickPuzzle, type Puzzle } from '../puzzle';
import { provisional, update, type Rating } from '../../shared/glicko';
import { h, toast } from '../ui/dom';
import { currentTheme, modal, topbar } from '../ui/parts';
import type { Screen } from '../main';

const RECENT = 300;
const RUSH_MS = 180_000;
const STRIKES = 3;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sideName = (s: 'w' | 'b') => (s === 'w' ? 'White' : 'Black');

export function puzzlesScreen(rush: boolean): Screen {
  let run: PuzzleRun | null = null;
  let token = 0;
  let busy = false;
  let failed = false;
  let rated = false;
  let hints = 0;
  // Rush state.
  let score = 0, strikes = 0, started = 0, timer = 0, over = false;
  const seen = new Set(getProfile().puzzle.recent);

  const host = h('div.board-host');
  const board = new BoardView(host);
  board.setTheme(currentTheme());
  const head = h('div.puzzle-head');
  const status = h('p.puzzle-status');
  const info = h('div.puzzle-info');
  const buttons = h('div.row');
  const el = h('div.screen.puzzles', {},
    topbar(rush ? 'Puzzle Rush' : 'Puzzles', (t) => board.setTheme(t)),
    h('div.game', {},
      h('div.stage', {}, host),
      h('aside.side.panel', {}, head, status, buttons, info,
        h('p.credits.small', {}, 'Puzzles from the ', h('a', { href: 'https://database.lichess.org/#puzzles', target: '_blank', rel: 'noopener' }, 'Lichess puzzle database'), ' (public domain).'))));

  board.onMove = (from, to, promotion) => void move(from, to, promotion);

  // ---------- rendering ----------

  function show(chess: Chess, last: Move | null | undefined, movable: boolean, animate = true): void {
    board.set(boardState(chess, movable && run ? run.side : null, last), animate);
  }

  function rating(): Rating { const p = getProfile().puzzle; return { rating: p.rating, rd: p.rd, vol: p.vol }; }

  function renderHead(delta?: number): void {
    if (rush) {
      const left = started ? Math.max(0, RUSH_MS - (performance.now() - started)) : RUSH_MS;
      const s = Math.ceil(left / 1000);
      head.replaceChildren(
        h('div.rush-score', {}, h('span.big', {}, String(score)), h('span.hint', {}, ' solved')),
        h('div.rush-meta', {},
          h('span.clock', { class: left < 20_000 ? 'low' : '' }, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`),
          h('span.strikes', {}, ...Array.from({ length: STRIKES }, (_, i) => h('span', { class: i < strikes ? 'x on' : 'x' }, '✕')))),
        h('p.hint', {}, `Best: ${getProfile().rushBest}`));
      return;
    }
    const r = rating();
    head.replaceChildren(
      h('div.rating-line', {},
        h('span.hint', {}, 'Your puzzle rating'),
        h('span.big', {}, `${Math.round(r.rating)}${provisional(r) ? '?' : ''}`),
        delta ? h('span.delta', { class: delta > 0 ? 'up' : 'down' }, `${delta > 0 ? '+' : ''}${delta}`) : null),
      h('p.hint', {}, `${getProfile().puzzle.solved} solved · ${getProfile().puzzle.failed} failed`));
  }

  function renderButtons(): void {
    const done = !run || run.solved || failed;
    if (rush) {
      buttons.replaceChildren(...(over || !started
        ? [h('button.primary.big', { onclick: startRush }, started ? 'Play again' : 'Start'), h('a.button', { href: '#puzzles' }, 'Rated puzzles')]
        : [h('button.danger', { onclick: () => endRush('You stopped the run.') }, 'Stop')]));
      return;
    }
    buttons.replaceChildren(
      ...(run && !run.solved
        ? [h('button', { onclick: hint, disabled: busy }, hints ? 'Show move' : 'Hint'), h('button', { onclick: () => void solution(), disabled: busy }, 'Solution')]
        : []),
      ...(done ? [h('button.primary', { onclick: () => void next() }, 'Next puzzle')] : []),
      ...(run && failed && !run.solved ? [h('button', { onclick: () => void retry() }, 'Retry')] : []),
      ...(run && (run.solved || failed) ? [h('button', { onclick: analyse }, 'Analyse')] : []),
      h('a.button', { href: '#rush' }, 'Puzzle Rush'));
  }

  function renderInfo(p: Puzzle | null, reveal: boolean): void {
    if (!p) { info.replaceChildren(); return; }
    info.replaceChildren(
      h('p.hint', {}, reveal ? `Puzzle rated ${p.rating}` : 'Puzzle rating hidden until you finish'),
      reveal && p.themes.length ? h('div.themes', {}, ...p.themes.map((t) => h('span.tag', {}, THEME_NAMES[t] ?? t))) : '',
      reveal ? h('p.hint', {}, h('a', { href: `https://lichess.org/training/${p.id}`, target: '_blank', rel: 'noopener' }, `Lichess #${p.id}`)) : '');
  }

  // ---------- flow ----------

  async function next(): Promise<void> {
    const mine = ++token;
    busy = true;
    failed = false;
    rated = false;
    hints = 0;
    board.setArrows([]);
    status.textContent = 'Loading…';
    let p: Puzzle;
    try {
      const target = rush ? 450 + score * 70 : rating().rating;
      p = await pickPuzzle(target, seen);
    } catch (e) {
      status.textContent = `Couldn't load puzzles: ${(e as Error).message}`;
      busy = false;
      return;
    }
    if (mine !== token) return;
    seen.add(p.id);
    run = new PuzzleRun(p);
    board.setOrientation(run.side);
    show(new Chess(p.fen), null, false, false);
    renderInfo(p, false);
    renderButtons();
    status.textContent = `${sideName(run.side)} to move…`;
    await wait(rush ? 350 : 650);
    if (mine !== token) return;
    const first = run.start();
    sound(soundFor(first, run.chess));
    busy = false;
    show(run.chess, first, true);
    status.textContent = `Find the best move for ${sideName(run.side)}.`;
    renderButtons();
  }

  async function move(from: Square, to: Square, promotion?: PieceType): Promise<void> {
    if (!run || busy || run.solved || (rush && over)) return;
    const mine = token;
    const p = new Chess(run.chess.fen());
    let uci = from + to;
    try { const m = p.move({ from, to, promotion }); uci = m.lan; } catch { show(run.chess, run.history.at(-1), true, false); return; }
    const a = run.attempt(uci);
    if (a.kind === 'wrong') {
      sound('wrong');
      show(run.chess, run.history.at(-1), !rush, false);
      if (rush) { strike(); return; }
      fail();
      status.textContent = 'Not this one. Try again, or look at the solution.';
      renderButtons();
      return;
    }
    sound(soundFor(a.move, new Chess(a.move.after)));
    if (a.kind === 'solved') { solve(a.move); return; }
    busy = true;
    show(new Chess(a.move.after), a.move, false, false);
    status.textContent = 'Good move! Keep going.';
    await wait(rush ? 250 : 450);
    if (mine !== token) return;
    busy = false;
    sound(soundFor(a.reply, run.chess));
    show(run.chess, a.reply, true);
    renderButtons();
  }

  function solve(last: Move): void {
    show(run!.chess, last, false, false);
    if (rush) {
      score++;
      sound('right');
      renderHead();
      void next();
      return;
    }
    sound('right');
    status.textContent = failed ? 'Solved, but it took more than one go.' : 'Solved!';
    if (!failed) settle(1);
    renderInfo(run!.puzzle, true);
    renderButtons();
  }

  function fail(): void {
    if (failed) return;
    failed = true;
    settle(0);
  }

  /** Rate this puzzle once: 1 for a clean solve, 0 for anything else. */
  function settle(result: 0 | 1): void {
    if (rated || rush || !run) return;
    rated = true;
    const before = rating();
    const after = update(before, [{ opponent: { rating: run.puzzle.rating, rd: 80 }, score: result }], 0.75);
    const id = run.puzzle.id;
    saveProfile((p) => {
      p.puzzle = { ...p.puzzle, ...after, solved: p.puzzle.solved + result, failed: p.puzzle.failed + (1 - result), recent: [...p.puzzle.recent.filter((x) => x !== id), id].slice(-RECENT) };
    });
    renderHead(Math.round(after.rating - before.rating));
  }

  function hint(): void {
    if (!run || run.solved) return;
    fail();
    const { from, to } = parseUci(run.expected);
    board.setArrows(hints++ === 0 ? [{ from, to: from, color: '#5ab0d8' }] : [{ from, to, color: '#5ab0d8' }]);
    status.textContent = hints === 1 ? 'This piece has the answer.' : 'This move.';
    renderButtons();
  }

  async function solution(): Promise<void> {
    if (!run || run.solved) return;
    fail();
    const mine = token;
    busy = true;
    board.setArrows([]);
    renderButtons();
    status.textContent = 'The solution:';
    while (run && !run.solved && mine === token) {
      const a = run.attempt(run.expected);
      if (a.kind === 'wrong') break;
      sound(soundFor(a.move, new Chess(a.move.after)));
      show(new Chess(a.move.after), a.move, false);
      await wait(700);
      if (a.kind === 'correct' && mine === token) { show(run.chess, a.reply, false); await wait(700); }
    }
    if (mine !== token) return;
    busy = false;
    renderInfo(run!.puzzle, true);
    renderButtons();
  }

  async function retry(): Promise<void> {
    if (!run) return;
    const p = run.puzzle;
    const mine = ++token;
    run = new PuzzleRun(p);
    hints = 0;
    board.setArrows([]);
    show(new Chess(p.fen), null, false, false);
    await wait(400);
    if (mine !== token) return;
    const first = run.start();
    show(run.chess, first, true);
    status.textContent = `Find the best move for ${sideName(run.side)}. (This one no longer counts.)`;
    renderButtons();
  }

  function analyse(): void {
    if (!run) return;
    const c = new Chess(run.puzzle.fen);
    for (const m of run.history) c.move(m.san);
    try { sessionStorage.setItem('rookroll:analysis', c.pgn()); } catch { /* storage blocked */ }
    location.hash = '#analysis';
  }

  // ---------- rush ----------

  function startRush(): void {
    for (const m of document.querySelectorAll('.modal')) m.remove();
    score = 0; strikes = 0; over = false;
    started = performance.now();
    clearInterval(timer);
    timer = window.setInterval(() => {
      renderHead();
      if (performance.now() - started >= RUSH_MS) endRush("Time's up!");
    }, 250);
    renderHead();
    void next();
  }

  function strike(): void {
    strikes++;
    renderHead();
    if (strikes >= STRIKES) { endRush('Three strikes.'); return; }
    status.textContent = 'Strike! Next one.';
    void next();
  }

  function endRush(why: string): void {
    if (over) return;
    over = true;
    token++;
    clearInterval(timer);
    const best = getProfile().rushBest;
    if (score > best) saveProfile((p) => { p.rushBest = score; });
    show(run?.chess ?? new Chess(), run?.history.at(-1), false, false);
    status.textContent = why;
    renderHead();
    renderButtons();
    sound(score > best ? 'win' : 'draw');
    const m = modal(h('h2', {}, why), h('p.rush-final', {}, h('span.big', {}, String(score)), ' solved'),
      h('p', {}, score > best ? (best ? `New best! (was ${best})` : 'Your first score!') : `Best: ${best}`),
      h('div.row.end', {}, h('a.button', { href: '#', onclick: () => m.close() }, 'Home'), h('button.primary', { onclick: () => { m.close(); startRush(); } }, 'Play again')));
  }

  // ---------- start ----------

  const keys = (e: KeyboardEvent) => {
    if (e.key === 'f') board.flip();
    else if (e.key === 'Enter' && !rush && (run?.solved || failed)) void next();
  };
  window.addEventListener('keydown', keys);

  renderHead();
  if (rush) {
    show(new Chess(), null, false, false);
    status.textContent = 'Solve as many as you can in 3 minutes. Three wrong moves and you\'re out.';
    renderButtons();
  } else {
    void next();
  }
  if (!getProfile().puzzle.solved && !getProfile().puzzle.failed && !rush) toast('Your rating starts at 1500 and settles as you solve.', 3000);

  return {
    el,
    dispose() { token++; clearInterval(timer); window.removeEventListener('keydown', keys); },
  };
}
