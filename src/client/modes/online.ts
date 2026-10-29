// Online play: the lobby (#online) for quick matches and friend links, and a
// game (#online/<id>) for players and spectators alike. The relay keeps the
// game and the clocks; this page shows them and sends moves.

import { Chess, type Move, type Square } from 'chess.js';
import { loginUrl } from '../account';
import type { PieceType } from '../art/pieces';
import { play as sound } from '../audio';
import { BoardView } from '../board/view';
import { boardState, material, parseUci, soundFor } from '../game';
import { Relay, type Link } from '../net';
import { h, toast } from '../ui/dom';
import { currentTheme, modal, moveList, playerBar, playerPortrait, topbar } from '../ui/parts';
import type { Screen } from '../main';
import {
  CATEGORIES, CLAIM_MS, TIME_CONTROLS, categoryOf,
  type GameClientMsg, type GameServerMsg, type GameView, type LobbyClientMsg, type LobbyServerMsg,
  type PlayerInfo, type Rated, type Side, type TimeControl,
} from '../../shared/online';

const PREFS = 'rookroll:online';
interface Prefs { tc: TimeControl; rated: boolean; friendTc: TimeControl; side: Side | 'random' }

function prefs(): Prefs {
  const d: Prefs = { tc: '5+3', rated: true, friendTc: '10+5', side: 'random' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch { return d; }
}
function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* storage blocked */ }
}

const ratingText = (r?: Rated) => (r ? `${r.rating}${r.provisional ? '?' : ''}` : '');
const linkText: Record<Link, string> = { connecting: 'Connecting…', open: '', lost: 'Connection lost. Reconnecting…' };

// ---------------------------------------------------------------- lobby

export function onlineLobby(): Screen {
  const p = prefs();
  const relay = new Relay<LobbyServerMsg, LobbyClientMsg>({ lobby: '1' });
  let account = false;
  let seeking: { tc: TimeControl; rated: boolean; since: number; m: ReturnType<typeof modal>; clock: HTMLElement } | null = null;
  let counts: Partial<Record<TimeControl, number>> = {};

  const who = h('p.hint', {}, 'Connecting to the game server…');
  const ratings = h('div.ratings');
  const ratedBox = h('input', { type: 'checkbox', checked: p.rated, onchange: () => { p.rated = ratedBox.checked; savePrefs(p); } }) as HTMLInputElement;
  const ratedRow = h('label.check', {}, ratedBox, ' Rated');
  const grid = h('div.tc-grid');
  const friendTc = h('div.chips');
  const sideRow = h('div.chips');
  const createBtn = h('button.primary', { onclick: () => relay.send({ t: 'friend', tc: p.friendTc, side: p.side }) }, 'Create link');
  const online = h('p.hint');

  function drawGrid(): void {
    grid.replaceChildren(...TIME_CONTROLS.map((tc) =>
      h('button.tc', { onclick: () => seek(tc) },
        h('b', {}, tc), h('span', {}, categoryOf(tc)),
        counts[tc] ? h('span.count', {}, `${counts[tc]} waiting`) : null)));
    friendTc.replaceChildren(...TIME_CONTROLS.map((tc) =>
      h('button.chip', { class: tc === p.friendTc ? 'on' : '', onclick: () => { p.friendTc = tc; savePrefs(p); drawGrid(); } }, tc)));
    sideRow.replaceChildren(...(['w', 'random', 'b'] as const).map((s) =>
      h('button.chip', { class: s === p.side ? 'on' : '', onclick: () => { p.side = s; savePrefs(p); drawGrid(); } },
        s === 'w' ? 'White' : s === 'b' ? 'Black' : 'Random')));
  }

  function seek(tc: TimeControl): void {
    const rated = account && p.rated;
    if (!relay.send({ t: 'seek', tc, rated })) { toast('Not connected yet.'); return; }
    p.tc = tc; savePrefs(p);
    seeking?.m.close();
    const clock = h('span.hint', {}, '0:00');
    const m = modal(h('h2', {}, 'Finding an opponent'),
      h('p', {}, `${tc} · ${rated ? 'rated' : 'casual'} · `, clock),
      h('div.spinner', {}, h('span'), h('span'), h('span')),
      h('div.row.end', {}, h('button', { onclick: cancel }, 'Cancel')));
    seeking = { tc, rated, since: Date.now(), m, clock };
  }

  function cancel(): void {
    relay.send({ t: 'cancel' });
    seeking?.m.close();
    seeking = null;
  }

  const tick = window.setInterval(() => {
    if (!seeking) return;
    const s = Math.floor((Date.now() - seeking.since) / 1000);
    seeking.clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);

  relay.onLink = (l) => { if (l !== 'open') who.textContent = linkText[l]; };
  relay.onMessage = (m) => {
    if (m.t === 'hello') {
      account = m.account;
      who.replaceChildren(account
        ? `Signed in as ${m.name}.`
        : h('span', {}, `Playing as ${m.name}. `, h('a', { href: loginUrl(), target: '_top' }, 'Sign in'), ' to play rated games.'));
      ratedRow.classList.toggle('hidden', !account);
      ratings.replaceChildren(...(account ? CATEGORIES.map((c) => {
        const r = m.ratings[c];
        return h('div.rating-chip', {}, h('span', {}, c), h('b', {}, r ? ratingText(r) : '1500?'), h('span.hint', {}, r ? `${r.games} games` : 'new'));
      }) : []));
      // A reconnect drops the seek on the server: ask again.
      if (seeking) relay.send({ t: 'seek', tc: seeking.tc, rated: seeking.rated });
    } else if (m.t === 'counts') {
      counts = m.seeking;
      online.textContent = `${m.online} ${m.online === 1 ? 'player' : 'players'} in the lobby.`;
      drawGrid();
    } else if (m.t === 'matched' || m.t === 'created') {
      seeking?.m.close();
      seeking = null;
      location.hash = `#online/${m.id}`;
    } else if (m.t === 'error') toast(m.message);
  };

  drawGrid();
  const el = h('div.screen.online', {},
    topbar('Play online'),
    h('main.online-main', {},
      h('section.panel', {},
        h('h2', {}, 'Quick match'),
        who, ratings,
        h('div.row.top', {}, h('h3', {}, 'Time control'), ratedRow),
        grid, online),
      h('section.panel', {},
        h('h2', {}, 'Play a friend'),
        h('p.hint', {}, 'Make a link and send it. The first person to open it plays you. Friend games are casual.'),
        h('h3', {}, 'Time control'), friendTc,
        h('h3', {}, 'You play'), sideRow,
        h('div.row', { style: 'margin-top:14px' }, createBtn))));
  ratedRow.classList.add('hidden');
  return { el, dispose() { clearInterval(tick); if (seeking) relay.send({ t: 'cancel' }); seeking?.m.close(); relay.close(); } };
}

// ---------------------------------------------------------------- game

export function onlineGame(id: string): Screen {
  const relay = new Relay<GameServerMsg, GameClientMsg>({ game: id });
  let g: GameView | null = null;
  let you: Side | null = null;
  let skew = 0;
  const chess = new Chess();
  let ply = 0;
  let shownEnd = false;
  let pending: string | null = null;
  let link: Link = 'connecting';

  const host = h('div.board-host');
  const board = new BoardView(host);
  board.setTheme(currentTheme());
  const top = playerBar(), bottom = playerBar();
  const topClock = h('div.clock-chip'), bottomClock = h('div.clock-chip');
  top.el.append(topClock);
  bottom.el.append(bottomClock);
  const head = h('div.online-head');
  const invite = h('div.invite.hidden');
  const list = h('div.list-wrap');
  const status = h('p.status-line');
  const offer = h('div.offer.hidden');
  const abortBtn = h('button', { onclick: () => relay.send({ t: 'abort' }) }, 'Abort');
  const drawBtn = h('button', { onclick: () => { relay.send({ t: 'draw' }); } }, 'Offer draw');
  const resignBtn = h('button.danger', { onclick: confirmResign }, 'Resign');
  const claimBtn = h('button.primary.hidden', { onclick: () => relay.send({ t: 'claim' }) }, 'Claim the win');
  const actions = h('div.row', {}, abortBtn, drawBtn, resignBtn, claimBtn);
  const rematchBtn = h('button', { onclick: () => relay.send({ t: 'rematch' }) }, 'Rematch');
  const after = h('div.row.after.hidden', {},
    h('button.primary', { onclick: toReview }, 'Game review'), rematchBtn,
    h('a.button', { href: '#online' }, 'New opponent'));

  const el = h('div.screen.play', {},
    topbar('Online', (t) => board.setTheme(t)),
    h('div.game', {},
      h('div.stage', {}, top.el, host, bottom.el),
      h('aside.side.panel', {}, head, invite, list, status, offer,
        h('div.row.nav', {},
          h('button', { onclick: () => step(-1), 'aria-label': 'Previous move' }, '◂'),
          h('button', { onclick: () => step(1), 'aria-label': 'Next move' }, '▸'),
          h('button', { onclick: () => step(Infinity), 'aria-label': 'Latest move' }, '▸▸'),
          h('button', { onclick: () => { board.flip(); render(false); } }, 'Flip')),
        actions, after)));

  board.onMove = (from, to, promotion) => userMove(from, to, promotion);

  const history = (): Move[] => chess.history({ verbose: true });
  const serverNow = () => Date.now() - skew;
  const uciOf = (m: Move) => m.from + m.to + (m.promotion ?? '');

  function step(d: number): void {
    ply = Math.max(0, Math.min(history().length, ply + d));
    render();
  }

  function left(side: Side): number {
    if (!g) return 0;
    const turn = g.moves.length % 2 === 0 ? 'w' : 'b';
    return g.running && turn === side ? Math.max(0, g.clocks[side] - (serverNow() - g.turnStart)) : g.clocks[side];
  }

  function fmt(ms: number): string {
    if (ms < 10_000) return (Math.floor(ms / 100) / 10).toFixed(1);
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function drawClocks(): void {
    if (!g) return;
    const mine: Side = board.side;
    const turn = g.moves.length % 2 === 0 ? 'w' : 'b';
    for (const [elc, side] of [[bottomClock, mine], [topClock, mine === 'w' ? 'b' : 'w']] as const) {
      const ms = left(side);
      elc.textContent = fmt(ms);
      elc.classList.toggle('on', g.status === 'playing' && g.running && turn === side);
      elc.classList.toggle('low', g.status === 'playing' && ms < 20_000);
    }
    if (g.status === 'playing' && !g.running && g.firstMoveBy) {
      const s = Math.max(0, Math.ceil((g.firstMoveBy - serverNow()) / 1000));
      const who = turn === you ? 'You have' : `${turn === 'w' ? 'White' : 'Black'} has`;
      if (ply === history().length) status.textContent = `${who} ${s} s to make the first move.`;
    }
    const opp = you ? (you === 'w' ? 'b' : 'w') : null;
    const since = opp ? g.gone[opp] : undefined;
    const canClaim = g.status === 'playing' && since !== undefined && serverNow() - since >= CLAIM_MS;
    claimBtn.classList.toggle('hidden', !canClaim);
    if (g.status === 'playing' && since !== undefined && ply === history().length) {
      const wait = Math.ceil((since + CLAIM_MS - serverNow()) / 1000);
      status.textContent = wait > 0 ? `Your opponent left. If they're not back in ${wait} s, you can claim the win.` : 'Your opponent left. Claim the win, or wait for them.';
    }
  }
  const clockTimer = window.setInterval(drawClocks, 100);

  function bar(b: ReturnType<typeof playerBar>, side: Side): void {
    const info: PlayerInfo | null = g?.players[side] ?? null;
    const view = ply === history().length ? chess : new Chess(ply ? history()[ply - 1].after : undefined);
    const mat = material(view);
    const change = g?.result?.change?.[side];
    const rating = change ? `${change.after} (${change.after >= change.before ? '+' : ''}${change.after - change.before})` : ratingText(info?.rating);
    const gone = g?.status === 'playing' && g.gone[side] !== undefined;
    b.set({
      avatar: info ? playerPortrait(info.name, 2) : h('div.you', {}, '?'),
      name: info ? info.name + (side === you ? ' (you)' : '') : 'Waiting for a player…',
      sub: rating,
      captured: mat[side].captured, capturedSide: side === 'w' ? 'b' : 'w', lead: mat[side].lead,
      status: gone ? 'left' : g?.drawOffer === side && g.status === 'playing' ? 'offers a draw' : '',
    });
  }

  function render(animate = true): void {
    if (!g) return;
    const moves = history();
    const live = ply === moves.length;
    const view = live ? chess : new Chess(ply ? moves[ply - 1].after : undefined);
    const turn = chess.turn();
    const myTurn = g.status === 'playing' && you === turn && live && !pending;
    board.set(boardState(view, myTurn ? you : null, moves[ply - 1]), animate);
    const bottomSide = board.side, topSide = bottomSide === 'w' ? 'b' : 'w';
    bar(bottom, bottomSide);
    bar(top, topSide);
    list.replaceChildren(moveList(moves, ply, (p) => { ply = p; render(); }));
    head.replaceChildren(h('h2', {}, `${g.tc} · ${g.rated ? 'Rated' : 'Casual'}`),
      h('p.hint', {}, you ? `${categoryOf(g.tc)} · you play ${you === 'w' ? 'White' : 'Black'}` : `${categoryOf(g.tc)} · watching`));
    invite.classList.toggle('hidden', g.status !== 'waiting');
    status.textContent = link !== 'open' ? linkText[link]
      : g.status === 'over' ? describe()
      : g.status === 'waiting' ? 'Waiting for your friend to open the link.'
      : !live ? 'Looking back. Press ▸▸ to return to the game.'
      : !you ? `${turn === 'w' ? 'White' : 'Black'} to move.`
      : turn === you ? (chess.inCheck() ? 'Check! Your move.' : 'Your move.') : 'Waiting for your opponent…';
    const opp = you === 'w' ? 'b' : 'w';
    const offered = g.status === 'playing' && you !== null && g.drawOffer === opp;
    offer.classList.toggle('hidden', !offered);
    if (offered) offer.replaceChildren(h('p', {}, 'Your opponent offers a draw.'),
      h('div.row', {}, h('button.primary', { onclick: () => relay.send({ t: 'draw' }) }, 'Accept'), h('button', { onclick: () => relay.send({ t: 'decline' }) }, 'Decline')));
    const playing = g.status === 'playing' && you !== null;
    actions.classList.toggle('hidden', !playing);
    abortBtn.classList.toggle('hidden', g.running || g.moves.length >= 2);
    drawBtn.classList.toggle('hidden', !g.running);
    drawBtn.disabled = g.drawOffer === you;
    drawBtn.textContent = g.drawOffer === you ? 'Draw offered' : 'Offer draw';
    resignBtn.classList.toggle('hidden', !g.running);
    after.classList.toggle('hidden', g.status !== 'over');
    const bothSeated = Boolean(g.players.w && g.players.b);
    rematchBtn.classList.toggle('hidden', !you || !bothSeated);
    rematchBtn.disabled = g.rematchOffer === you;
    rematchBtn.textContent = g.rematchOffer === you ? 'Rematch asked' : g.rematchOffer ? 'Accept rematch' : 'Rematch';
    rematchBtn.classList.toggle('primary', Boolean(g.rematchOffer && g.rematchOffer !== you));
    drawClocks();
  }

  function describe(): string {
    const r = g?.result;
    if (!r) return '';
    if (r.reason === 'aborted') return 'Game aborted.';
    const name = (s: Side) => (s === you ? 'You' : g!.players[s]?.name ?? (s === 'w' ? 'White' : 'Black'));
    if (!r.winner) return `Draw by ${r.reason}.`;
    return `${name(r.winner)} won by ${r.reason}${r.winner === you ? '!' : '.'}`;
  }

  /** Bring the local game in line with the relay's move list; `sent` is the move this page just sent, if any. */
  function sync(moves: string[], sent: string | null = null): void {
    const mine = history().map(uciOf);
    const extends_ = mine.length <= moves.length && mine.every((u, i) => u === moves[i]);
    const wasLive = ply === mine.length;
    if (!extends_) {
      chess.reset();
      for (const u of moves) chess.move(parseUci(u));
      ply = moves.length;
      render(false);
      return;
    }
    let last: Move | null = null;
    for (const u of moves.slice(mine.length)) last = chess.move(parseUci(u));
    if (wasLive) ply = moves.length;
    const theirs = Boolean(last) && sent !== uciOf(last!);
    if (theirs) sound(soundFor(last!, chess));
    render(theirs);
  }

  function userMove(from: Square, to: Square, promotion?: PieceType): void {
    if (!g || g.status !== 'playing' || chess.turn() !== you || pending) return;
    let move: Move;
    try { move = chess.move({ from, to, promotion }); } catch { render(false); return; }
    const uci = uciOf(move);
    if (!relay.send({ t: 'move', uci, ply: g.moves.length })) {
      chess.undo();
      toast('Not connected: the move was not sent.');
      render(false);
      return;
    }
    pending = uci;
    ply = history().length;
    sound(soundFor(move, chess));
    render(false);
  }

  function confirmResign(): void {
    const m = modal(h('h2', {}, 'Resign?'), h('p', {}, 'Your opponent takes the win.'),
      h('div.row.end', {}, h('button', { onclick: () => m.close() }, 'Keep playing'),
        h('button.danger', { onclick: () => { m.close(); relay.send({ t: 'resign' }); } }, 'Resign')));
  }

  function finished(): void {
    if (!g?.result || shownEnd) return;
    shownEnd = true;
    const r = g.result;
    const res = r.reason === 'aborted' || !you ? null : r.winner === null ? 'd' : r.winner === you ? 'w' : 'l';
    if (res) setTimeout(() => sound(res === 'w' ? 'win' : res === 'l' ? 'lose' : 'draw'), 250);
    const change = you ? r.change?.[you] : undefined;
    const title = r.reason === 'aborted' ? 'Aborted' : !you ? (r.winner ? `${r.winner === 'w' ? 'White' : 'Black'} wins` : 'Draw') : res === 'w' ? 'You win!' : res === 'l' ? 'You lost' : 'Draw';
    const m = modal(h('h2', {}, title), h('p', {}, describe()),
      ...(change ? [h('p.delta', { class: change.after >= change.before ? 'up' : 'down' }, `Rating ${change.before} → ${change.after} (${change.after >= change.before ? '+' : ''}${change.after - change.before})`)] : []),
      h('div.row.end', {},
        h('button', { onclick: () => m.close() }, 'Look at the board'),
        r.reason === 'aborted' ? h('a.button.primary', { href: '#online', onclick: () => m.close() }, 'New opponent')
          : h('button.primary', { onclick: () => { m.close(); toReview(); } }, 'Game review')));
  }

  function toReview(): void {
    const c = new Chess();
    for (const u of g?.moves ?? []) c.move(parseUci(u));
    c.setHeader('Event', `ROOK & ROLL ${g?.rated ? 'rated' : 'casual'} ${g?.tc ?? ''}`);
    c.setHeader('White', g?.players.w?.name ?? 'White');
    c.setHeader('Black', g?.players.b?.name ?? 'Black');
    if (g?.result) c.setHeader('Result', g.result.winner === 'w' ? '1-0' : g.result.winner === 'b' ? '0-1' : g.result.reason === 'aborted' ? '*' : '1/2-1/2');
    try { sessionStorage.setItem('rookroll:review', c.pgn()); } catch { /* storage blocked */ }
    location.hash = '#review';
  }

  // A query, not a hash: the guard wraps a shared link in the hub's frame and
  // passes the query on to the game, but a fragment never reaches it.
  const shareUrl = `${location.origin}${location.pathname}?game=${id}`;
  const linkBox = h('input', { readOnly: true, value: shareUrl, onfocus: (e: Event) => (e.target as HTMLInputElement).select() }) as HTMLInputElement;
  invite.append(h('h3', {}, 'Invite a friend'), h('p.hint', {}, 'Send them this link. The game starts when they open it.'),
    h('div.row', {}, linkBox, h('button', { onclick: () => { void navigator.clipboard?.writeText(shareUrl).then(() => toast('Link copied.'), () => linkBox.select()); } }, 'Copy')));

  relay.onLink = (l) => { link = l; render(false); };
  relay.onFatal = () => {
    el.querySelector('.game')!.replaceWith(h('div.panel.lost', {}, h('h2', {}, 'No such game'),
      h('p', {}, 'This game does not exist, or it ended a while ago.'), h('a.button.primary', { href: '#online' }, 'Play online')));
  };
  relay.onMessage = (m) => {
    if (m.t === 'error') {
      toast(m.message);
      pending = null;
      if (g) sync(g.moves);
      return;
    }
    const first = !g;
    g = m.game;
    you = m.you;
    skew = Date.now() - g.now;
    if (first) board.setOrientation(you ?? 'w');
    // On the first state, the whole game so far appears without a slide or a sound.
    const sent = first ? g.moves.at(-1) ?? null : pending;
    pending = null;
    sync(g.moves, sent);
    if (g.rematchId) { location.hash = `#online/${g.rematchId}`; return; }
    if (g.status === 'over') finished();
  };

  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const n = history().length;
    if (e.key === 'ArrowLeft') ply = Math.max(0, ply - 1);
    else if (e.key === 'ArrowRight') ply = Math.min(n, ply + 1);
    else if (e.key === 'End') ply = n;
    else if (e.key === 'f') { board.flip(); render(false); return; }
    else return;
    e.preventDefault();
    render();
  };
  window.addEventListener('keydown', keys);

  return { el, dispose() { clearInterval(clockTimer); window.removeEventListener('keydown', keys); relay.close(); } };
}
