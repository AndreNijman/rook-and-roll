// A game against one of the bots. The game in progress is kept in this
// browser, so a reload or a trip to the home screen picks it back up.

import { Chess, type Move, type Square } from 'chess.js';
import { saveProfile } from '../account';
import type { PieceType, Side } from '../art/pieces';
import { play as sound } from '../audio';
import { BOTS, botOptions, pickMove, type Bot } from '../bots';
import { BoardView } from '../board/view';
import { FULL, engine } from '../engine/shared';
import { boardState, material, outcome, parseUci, soundFor, type Outcome } from '../game';
import { h } from '../ui/dom';
import { currentTheme, modal, moveList, playerBar, portrait, topbar, youAvatar } from '../ui/parts';
import type { Screen } from '../main';

const SAVE = 'pawnstorm:botgame';

export interface SavedGame { bot: string; side: Side; pgn: string; over?: boolean }

export function savedGame(): SavedGame | null {
  try {
    const g = JSON.parse(localStorage.getItem(SAVE) || 'null') as SavedGame | null;
    return g && !g.over && BOTS.some((b) => b.id === g.bot) ? g : null;
  } catch { return null; }
}

export function startGame(bot: Bot, side: Side): void {
  try { localStorage.setItem(SAVE, JSON.stringify({ bot: bot.id, side, pgn: '' })); } catch { /* storage blocked */ }
}

export function playScreen(): Screen | null {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(SAVE) || 'null') as SavedGame | null; } catch { return null; } })();
  const bot = BOTS.find((b) => b.id === saved?.bot);
  if (!saved || !bot) return null;

  const me: Side = saved.side;
  const chess = new Chess();
  if (saved.pgn) try { chess.loadPgn(saved.pgn); } catch { /* corrupt save: start over */ }
  let over: Outcome | null = saved.over ? outcome(chess) ?? { winner: null, reason: 'finished' } : null;
  let ply = chess.history().length;
  let token = 0;
  let thinking = false;

  const host = h('div.board-host');
  const board = new BoardView(host);
  board.setTheme(currentTheme());
  board.setOrientation(me);
  const top = playerBar(), bottom = playerBar();
  const list = h('div.list-wrap');
  const status = h('p.status-line');
  const hintBtn = h('button', { onclick: hint }, 'Hint');
  const backBtn = h('button', { onclick: takeback }, 'Takeback');
  const resignBtn = h('button.danger', { onclick: resign }, 'Resign');
  const after = h('div.row.after.hidden', {},
    h('button.primary', { onclick: () => toReview() }, 'Game review'),
    h('button', { onclick: rematch }, 'Rematch'),
    h('a.button', { href: '#bots' }, 'New bot'));

  const el = h('div.screen.play', {},
    topbar(`vs ${bot.name}`, (t) => board.setTheme(t)),
    h('div.game', {},
      h('div.stage', {}, top.el, host, bottom.el),
      h('aside.side.panel', {},
        h('div.botline', {}, portrait(bot, 3), h('div', {}, h('h2', {}, bot.name), h('p.hint', {}, `${bot.rating} · ${bot.blurb}`))),
        list, status,
        h('div.row', {}, hintBtn, backBtn, h('button', { onclick: () => board.flip() }, 'Flip'), resignBtn),
        after)));

  board.onMove = (from, to, promotion) => userMove(from, to, promotion);

  function history(): Move[] { return chess.history({ verbose: true }); }

  function save(): void {
    try { localStorage.setItem(SAVE, JSON.stringify({ bot: bot!.id, side: me, pgn: chess.pgn(), over: Boolean(over) })); } catch { /* storage blocked */ }
  }

  function render(animate = true): void {
    const moves = history();
    const live = ply === moves.length;
    const view = live ? chess : new Chess(ply ? moves[ply - 1].after : undefined);
    board.set(boardState(view, live && !over && !thinking ? me : null, moves[ply - 1]), animate);
    const mat = material(view);
    const them: Side = me === 'w' ? 'b' : 'w';
    top.set({ avatar: portrait(bot!, 2), name: bot!.name, sub: String(bot!.rating), captured: mat[them].captured, capturedSide: me, lead: mat[them].lead, status: thinking ? 'thinking…' : '' });
    bottom.set({ avatar: youAvatar(), name: 'You', captured: mat[me].captured, capturedSide: them, lead: mat[me].lead });
    list.replaceChildren(moveList(moves, ply, (p) => { ply = p; render(); }));
    status.textContent = over ? describe(over) : !live ? 'Looking back. Press ▸ or a later move to return.' : chess.turn() === me ? (chess.inCheck() ? 'Check! Your move.' : 'Your move.') : `${bot!.name} is thinking…`;
    hintBtn.disabled = Boolean(over) || thinking || !live;
    backBtn.disabled = Boolean(over) || thinking || moves.length < 1 || (moves.length < 2 && me === 'w');
    resignBtn.disabled = Boolean(over);
    after.classList.toggle('hidden', !over);
  }

  function describe(o: Outcome): string {
    if (!o.winner) return `Draw by ${o.reason}.`;
    return o.winner === me ? `You won by ${o.reason}!` : `${bot!.name} won by ${o.reason}.`;
  }

  function apply(m: { from: Square; to: Square; promotion?: string }): boolean {
    let move: Move;
    try { move = chess.move(m); } catch { return false; }
    ply = chess.history().length;
    board.setArrows([]);
    sound(soundFor(move, chess));
    const end = outcome(chess);
    if (end) finish(end);
    save();
    return true;
  }

  function userMove(from: Square, to: Square, promotion?: PieceType): void {
    if (over || chess.turn() !== me) return;
    if (!apply({ from, to, promotion })) { render(false); return; }
    render(false);
    if (!over) void botMove();
  }

  async function botMove(): Promise<void> {
    const mine = ++token;
    thinking = true;
    render();
    const started = performance.now();
    const fen = chess.fen();
    const result = await engine().search(fen, { depth: bot!.depth, multipv: bot!.multipv, options: botOptions(bot!) });
    // A little jitter so the bot's pace doesn't feel mechanical.
    const wait = bot!.think * (0.6 + Math.random() * 0.8) - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (mine !== token || chess.fen() !== fen) return;
    thinking = false;
    const uci = pickMove(bot!, result.lines, result.bestmove);
    if (!uci || !apply(parseUci(uci))) {
      // Engine gave nothing usable: fall back to any legal move.
      const any = chess.moves({ verbose: true })[0];
      if (any) apply(any);
    }
    render();
  }

  async function hint(): Promise<void> {
    if (over || chess.turn() !== me) return;
    hintBtn.disabled = true;
    const fen = chess.fen();
    const r = await engine().search(fen, { depth: 14, options: FULL });
    if (chess.fen() !== fen || !r.bestmove) return;
    const { from, to } = parseUci(r.bestmove);
    board.setArrows([{ from, to, color: '#5ab0d8' }]);
    hintBtn.disabled = false;
  }

  function takeback(): void {
    token++;
    thinking = false;
    engine().stop();
    chess.undo();
    if (chess.turn() !== me) chess.undo();
    ply = chess.history().length;
    board.setArrows([]);
    save();
    render();
  }

  function resign(): void {
    if (over) return;
    const m = modal(h('h2', {}, 'Resign?'), h('p', {}, `${bot!.name} will take the win.`),
      h('div.row.end', {}, h('button', { onclick: () => m.close() }, 'Keep playing'),
        h('button.danger', { onclick: () => { m.close(); token++; engine().stop(); thinking = false; finish({ winner: me === 'w' ? 'b' : 'w', reason: 'resignation' }); save(); render(); } }, 'Resign')));
  }

  function finish(o: Outcome): void {
    over = o;
    const res = o.winner === null ? 'd' : o.winner === me ? 'w' : 'l';
    saveProfile((p) => {
      const r = (p.bots[bot!.id] ??= { w: 0, l: 0, d: 0 });
      r[res]++;
    });
    setTimeout(() => sound(res === 'w' ? 'win' : res === 'l' ? 'lose' : 'draw'), 250);
    const m = modal(
      h('div.result', {}, portrait(bot!, 4),
        h('div', {}, h('h2', {}, res === 'w' ? 'You win!' : res === 'l' ? `${bot!.name} wins` : 'Draw'), h('p', {}, describe(o)))),
      h('div.row.end', {},
        h('button', { onclick: () => m.close() }, 'Look at the board'),
        h('button', { onclick: () => { m.close(); rematch(); } }, 'Rematch'),
        h('button.primary', { onclick: () => { m.close(); toReview(); } }, 'Game review')));
  }

  function rematch(): void {
    startGame(bot!, me === 'w' ? 'b' : 'w');
    // Re-enter the screen so everything starts clean.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  function toReview(): void {
    chess.setHeader('White', me === 'w' ? 'You' : bot!.name);
    chess.setHeader('Black', me === 'b' ? 'You' : bot!.name);
    try { sessionStorage.setItem('pawnstorm:review', chess.pgn()); } catch { /* storage blocked */ }
    location.hash = '#review';
  }

  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const n = history().length;
    if (e.key === 'ArrowLeft') ply = Math.max(0, ply - 1);
    else if (e.key === 'ArrowRight') ply = Math.min(n, ply + 1);
    else if (e.key === 'f') { board.flip(); return; }
    else return;
    e.preventDefault();
    render();
  };
  window.addEventListener('keydown', keys);

  render(false);
  if (!over && chess.turn() !== me) void botMove();

  return {
    el,
    dispose() { token++; engine().stop(); window.removeEventListener('keydown', keys); },
  };
}
