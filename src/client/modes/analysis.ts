// The analysis board and game review. Any position can be explored with live
// engine lines; a whole game can be reviewed, which grades every move and
// gives each side an accuracy score. Moves made from an earlier position
// replace the rest of the game rather than branching.

import { Chess, DEFAULT_POSITION, type Move, type Square } from 'chess.js';
import type { PieceType, Side } from '../art/pieces';
import { play as sound } from '../audio';
import { BoardView } from '../board/view';
import { FULL, engine } from '../engine/shared';
import { flip, formatScore, winPercent, type Line, type Score } from '../engine/uci';
import { boardState, outcome, parseUci, soundFor } from '../game';
import { CLASS_INFO, CLASS_ORDER, review, type MoveClass, type Review } from '../review';
import { h, toast } from '../ui/dom';
import { currentTheme, moveList, topbar } from '../ui/parts';
import type { Screen } from '../main';

const STORE = 'pawnstorm:analysis';
const BEST_ARROW = '#8ad05a';

const VERDICT: Record<MoveClass, string> = {
  best: 'the best move', excellent: 'excellent', good: 'good', inaccuracy: 'an inaccuracy',
  mistake: 'a mistake', blunder: 'a blunder', forced: 'the only move',
};

interface Reviewed { wins: number[]; best: string[]; result: Review }

/** Win% for white from a score given from the side to move's point of view. */
const whiteWin = (s: Score, turn: Side) => (turn === 'w' ? winPercent(s) : 100 - winPercent(s));

export function analysisScreen(autoReview: boolean): Screen {
  let startFen = DEFAULT_POSITION;
  let moves: Move[] = [];
  let headers: Record<string, string> = {};
  let ply = 0;
  let engineOn = true;
  let lines: Line[] = [];
  let reviewed: Reviewed | null = null;
  let reviewing = false;
  let token = 0;

  const host = h('div.board-host');
  const board = new BoardView(host);
  board.setTheme(currentTheme());
  const evalFill = h('div.fill'), evalText = h('span.eval-text');
  const evalBar = h('div.evalbar', { title: 'Evaluation' }, evalFill, evalText);
  const linesBox = h('div.lines');
  const engineBtn = h('button.small', { onclick: () => { engineOn = !engineOn; analyse(); renderEngine(); } });
  const reviewBox = h('div.review');
  const list = h('div.list-wrap');
  const note = h('p.status-line');
  const pgnArea = h('textarea', { rows: 4, spellcheck: false, placeholder: 'Paste a PGN or FEN here' }) as HTMLTextAreaElement;

  const el = h('div.screen.analysis', {},
    topbar(autoReview ? 'Game review' : 'Analysis', (t) => board.setTheme(t)),
    h('div.game', {},
      h('div.stage.with-eval', {}, evalBar, host),
      h('aside.side.panel', {},
        h('div.row.top', {}, h('h3', {}, 'Engine'), engineBtn),
        linesBox,
        reviewBox,
        list, note,
        h('div.row.nav', {},
          h('button', { onclick: () => go(0), 'aria-label': 'First move' }, '◂◂'),
          h('button', { onclick: () => go(ply - 1), 'aria-label': 'Previous move' }, '◂'),
          h('button', { onclick: () => go(ply + 1), 'aria-label': 'Next move' }, '▸'),
          h('button', { onclick: () => go(moves.length), 'aria-label': 'Last move' }, '▸▸'),
          h('button', { onclick: () => board.flip() }, 'Flip')),
        h('details.io', {},
          h('summary', {}, 'Import / export'),
          pgnArea,
          h('div.row', {},
            h('button.primary', { onclick: () => load(pgnArea.value) }, 'Load'),
            h('button', { onclick: () => copy(pgn(), 'PGN copied') }, 'Copy PGN'),
            h('button', { onclick: () => copy(fenAt(ply), 'FEN copied') }, 'Copy FEN'),
            h('button', { onclick: download }, 'Download'),
            h('button', { onclick: () => { load(''); } }, 'Clear'))))));

  board.onMove = (from, to, promotion) => userMove(from, to, promotion);

  const fenAt = (p: number) => (p === 0 ? startFen : moves[p - 1].after);
  const firstSide = (): Side => (new Chess(startFen).turn());

  function go(p: number): void {
    ply = Math.max(0, Math.min(moves.length, p));
    render();
    analyse();
  }

  function userMove(from: Square, to: Square, promotion?: PieceType): void {
    const c = new Chess(fenAt(ply));
    let m: Move;
    try { m = c.move({ from, to, promotion }); } catch { render(); return; }
    sound(soundFor(m, c));
    if (moves[ply]?.lan === m.lan) {
      ply++;
    } else {
      moves = [...moves.slice(0, ply), m];
      ply++;
      if (reviewed) { reviewed = null; toast('The game changed, so the review was cleared.'); }
    }
    persist();
    render(false);
    analyse();
  }

  function load(text: string): void {
    token++;
    reviewed = null;
    text = text.trim();
    try {
      if (!text) {
        startFen = DEFAULT_POSITION; moves = []; headers = {};
      } else if (/^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}\s/.test(text)) {
        startFen = new Chess(text).fen(); moves = []; headers = {};
      } else {
        const c = new Chess();
        c.loadPgn(text);
        moves = c.history({ verbose: true });
        startFen = moves[0]?.before ?? c.fen();
        headers = Object.fromEntries(Object.entries(c.getHeaders()).filter(([, v]) => v));
      }
    } catch (e) {
      toast(`That didn't load: ${(e as Error).message}`, 3500);
      return;
    }
    ply = moves.length;
    persist();
    render(false);
    analyse();
  }

  function pgn(): string {
    const c = new Chess(startFen);
    for (const [k, v] of Object.entries(headers)) c.setHeader(k, v);
    if (startFen !== DEFAULT_POSITION) { c.setHeader('SetUp', '1'); c.setHeader('FEN', startFen); }
    for (const m of moves) c.move(m.san);
    return c.pgn();
  }

  function persist(): void {
    try { sessionStorage.setItem(STORE, pgn()); } catch { /* storage blocked */ }
  }

  function copy(text: string, done: string): void {
    void navigator.clipboard?.writeText(text).then(() => toast(done), () => { pgnArea.value = text; toast('Copied into the box below'); });
  }

  function download(): void {
    const a = h('a', { href: URL.createObjectURL(new Blob([pgn()], { type: 'application/x-chess-pgn' })), download: 'pawnstorm.pgn' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- engine ----------

  function analyse(): void {
    lines = [];
    renderEngine();
    if (!engineOn || reviewing) { engine().stop(); return; }
    const fen = fenAt(ply);
    if (outcome(new Chess(fen))) { engine().stop(); return; }
    void engine().search(fen, {
      depth: 20, multipv: 3, options: FULL,
      onInfo: (l) => { if (fenAt(ply) === fen) { lines = l; renderEngine(); } },
    });
  }

  function pvSan(fen: string, pv: string[], max = 8): string {
    const c = new Chess(fen);
    const out: string[] = [];
    for (const uci of pv.slice(0, max)) {
      const turn = c.turn(), num = c.moveNumber();
      let m: Move;
      try { m = c.move(parseUci(uci)); } catch { break; }
      if (turn === 'w') out.push(`${num}.${m.san}`);
      else out.push(out.length ? m.san : `${num}…${m.san}`);
    }
    return out.join(' ');
  }

  function renderEngine(): void {
    engineBtn.textContent = engineOn ? 'On' : 'Off';
    const fen = fenAt(ply);
    const c = new Chess(fen);
    const end = outcome(c);
    let win = 50, label = '0.0';
    if (end) {
      win = end.winner === 'w' ? 100 : end.winner === 'b' ? 0 : 50;
      label = end.winner ? (end.winner === 'w' ? '1-0' : '0-1') : '½-½';
    } else if (lines[0]) {
      win = whiteWin(lines[0].score, c.turn());
      label = formatScore(c.turn() === 'w' ? lines[0].score : flip(lines[0].score));
    } else if (reviewed) {
      win = reviewed.wins[ply];
      label = '';
    }
    evalFill.style.height = `${win}%`;
    evalText.textContent = label;
    evalBar.classList.toggle('black-ahead', win < 50);

    if (!engineOn) linesBox.replaceChildren(h('p.hint', {}, 'Engine off.'));
    else if (end) linesBox.replaceChildren(h('p.hint', {}, `Game over: ${end.winner ? `${end.winner === 'w' ? 'White' : 'Black'} wins by ${end.reason}` : `draw by ${end.reason}`}.`));
    else if (!lines.length) linesBox.replaceChildren(h('p.hint', {}, reviewing ? 'Busy reviewing…' : 'Thinking…'));
    else linesBox.replaceChildren(
      h('p.depth', {}, `Depth ${lines[0].depth}`),
      ...lines.map((l) => h('div.line', {},
        h('span.score', { class: whiteWin(l.score, c.turn()) >= 50 ? 'w' : 'b' }, formatScore(c.turn() === 'w' ? l.score : flip(l.score))),
        h('span.pv', {}, pvSan(fen, l.pv)))));
    paintArrows();
  }

  function paintArrows(): void {
    const arrows = [];
    if (reviewed && ply > 0) {
      const best = reviewed.best[ply - 1];
      if (best && moves[ply - 1].lan !== best) arrows.push({ ...parseUci(best), color: BEST_ARROW });
    } else if (engineOn && lines[0]?.pv[0]) {
      arrows.push({ ...parseUci(lines[0].pv[0]), color: BEST_ARROW });
    }
    board.setArrows(arrows);
  }

  // ---------- review ----------

  async function runReview(): Promise<void> {
    if (!moves.length || reviewing) return;
    const mine = ++token;
    reviewing = true;
    engine().stop();
    const fens = [startFen, ...moves.map((m) => m.after)];
    const wins: number[] = [], best: string[] = [];
    for (let i = 0; i < fens.length; i++) {
      renderReview(i / fens.length);
      const c = new Chess(fens[i]);
      const end = outcome(c);
      if (end) {
        wins.push(end.winner === 'w' ? 100 : end.winner === 'b' ? 0 : 50);
        best.push('');
        continue;
      }
      const r = await engine().search(fens[i], { depth: 14, movetime: 1500, options: FULL });
      if (mine !== token) { reviewing = false; return; }
      wins.push(whiteWin(r.lines[0]?.score ?? { cp: 0 }, c.turn()));
      best.push(r.bestmove);
    }
    const forced = fens.slice(0, -1).map((f) => new Chess(f).moves().length === 1);
    reviewed = { wins, best, result: review(wins, moves.map((m, i) => m.lan === best[i]), forced, firstSide()) };
    reviewing = false;
    render();
    analyse();
  }

  function renderReview(progress?: number): void {
    if (progress !== undefined) {
      reviewBox.replaceChildren(h('h3', {}, 'Reviewing…'), h('div.progress', {}, h('div', { style: `width:${Math.round(progress * 100)}%` })));
      return;
    }
    if (!reviewed) {
      reviewBox.replaceChildren(moves.length
        ? h('button.primary.wide', { onclick: () => void runReview() }, 'Review this game')
        : h('p.hint', {}, 'Make moves on the board, or load a game below.'));
      return;
    }
    const { result } = reviewed;
    const names = { w: headers.White || 'White', b: headers.Black || 'Black' };
    const acc = (s: Side) => (result.accuracy[s] === null ? '–' : result.accuracy[s]!.toFixed(1));
    const table = h('table.counts', {},
      h('tr', {}, h('th'), h('th', {}, names.w), h('th', {}, names.b)),
      h('tr.acc', {}, h('td', {}, 'Accuracy'), h('td', {}, acc('w')), h('td', {}, acc('b'))),
      ...CLASS_ORDER.map((c) => h('tr', {},
        h('td', {}, h('span.mark', { style: `color:${CLASS_INFO[c].color}` }, CLASS_INFO[c].mark), ' ', CLASS_INFO[c].label),
        h('td', {}, String(result.counts.w[c])), h('td', {}, String(result.counts.b[c])))));
    const current = ply > 0 ? result.moves[ply - 1] : null;
    const verdict = current
      ? h('p.verdict', {},
        h('b', { style: `color:${CLASS_INFO[current.cls].color}` }, `${moves[ply - 1].san} is ${VERDICT[current.cls]}`),
        current.cls !== 'best' && current.cls !== 'forced' && reviewed.best[ply - 1] ? `. Best was ${pvSan(fenAt(ply - 1), [reviewed.best[ply - 1]], 1)}.` : '.')
      : h('p.verdict.hint', {}, 'Step through the moves to see how each one was judged.');
    reviewBox.replaceChildren(graph(), verdict, table);
  }

  /** White's win% over the game; click to jump to a move. */
  function graph(): HTMLCanvasElement {
    const W = 160, H = 40;
    const cv = h('canvas.graph', { width: W, height: H, title: 'Evaluation over the game' }) as HTMLCanvasElement;
    const g = cv.getContext('2d')!;
    const wins = reviewed!.wins;
    const xAt = (i: number) => Math.round((i / Math.max(1, wins.length - 1)) * (W - 1));
    g.fillStyle = '#33233f';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#efe4cc';
    for (let x = 0; x < W; x++) {
      const t = (x / (W - 1)) * (wins.length - 1);
      const i = Math.floor(t), f = t - i;
      const w = wins[i] + ((wins[i + 1] ?? wins[i]) - wins[i]) * f;
      const y = Math.round(H - (w / 100) * H);
      g.fillRect(x, y, 1, H - y);
    }
    g.fillStyle = '#7a6290';
    g.fillRect(0, H / 2, W, 1);
    reviewed!.result.moves.forEach((m, i) => {
      if (m.cls === 'blunder' || m.cls === 'mistake') {
        g.fillStyle = CLASS_INFO[m.cls].color;
        g.fillRect(xAt(i + 1) - 1, Math.round(H - (wins[i + 1] / 100) * H) - 1, 3, 3);
      }
    });
    g.fillStyle = '#f0d060';
    g.fillRect(xAt(ply), 0, 1, H);
    cv.onclick = (e) => {
      const b = cv.getBoundingClientRect();
      go(Math.round(((e.clientX - b.left) / b.width) * (wins.length - 1)));
    };
    return cv;
  }

  function render(animate = true): void {
    const c = new Chess(fenAt(ply));
    board.set(boardState(c, 'both', moves[ply - 1]), animate);
    list.replaceChildren(moveList(moves, ply, go, reviewed?.result.moves.map((m) => m.cls), firstSide()));
    note.textContent = headers.White || headers.Black ? `${headers.White ?? '?'} vs ${headers.Black ?? '?'}${headers.Result && headers.Result !== '*' ? ` · ${headers.Result}` : ''}` : '';
    if (!reviewing) renderReview();
    renderEngine();
  }

  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'ArrowLeft') go(ply - 1);
    else if (e.key === 'ArrowRight') go(ply + 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(moves.length);
    else if (e.key === 'f') board.flip();
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', keys);

  let initial = '';
  try { initial = (autoReview ? sessionStorage.getItem('pawnstorm:review') : null) ?? sessionStorage.getItem(STORE) ?? ''; } catch { /* storage blocked */ }
  load(initial);
  if (autoReview && moves.length) {
    // Review from the start, from the player's side of the board.
    if (headers.Black === 'You') board.setOrientation('b');
    ply = 0;
    render(false);
    void runReview();
  }

  return {
    el,
    dispose() { token++; engine().stop(); window.removeEventListener('keydown', keys); },
  };
}
