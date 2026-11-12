// Spell Chess: chess plus a hand of spell cards, against a bot or a friend on
// the same board. The rules live in src/spell (no DOM); this file is the
// screen. The game is kept as a seed and a list of actions, so a reload, a
// takeback and the move log all come from replaying that list.

import type { Square } from 'chess.js';
import type { PieceType, Side } from '../art/pieces';
import { img, px, toCanvas } from '../art/pixel';
import { play as sound } from '../audio';
import { BOTS, type Bot } from '../bots';
import { BoardView, type BoardState, type Mark, type Pieces } from '../board/view';
import { LEVELS, botAction, type Action } from '../../spell/bot';
import {
  SPELL_IDS, findKing, inCheck, isSilenced, legalCasts, legalMoves, other, phantomTurnsLeft, rankOf, sqIdx, sqName, trapTurnsLeft,
  type Cast, type Color, type SpellId, type State,
} from '../../spell/engine';
import { act, replay, sideNow, takebackPoint, type Act, type Game } from '../../spell/game';
import { SPELLS } from '../../spell/spells';
import { canvasOf, h, toast } from '../ui/dom';
import { currentTheme, modal, pieceIcon, playerBar, portrait, topbar, youAvatar } from '../ui/parts';
import type { Screen } from '../main';

const SAVE = 'rookroll:spellgame';
const CODE = 'qtpzbm';

/** Three of the usual faces, at the three strengths of the spell bot. */
const FOES: { bot: Bot; level: number; title: string; blurb: string }[] = [
  { bot: BOTS[0], level: 0, title: 'Novice', blurb: 'Casts whatever is in hand and hopes for the best.' },
  { bot: BOTS[4], level: 1, title: 'Adept', blurb: 'Looks a move ahead and saves spells for when they bite.' },
  { bot: BOTS[6], level: 2, title: 'Archmage', blurb: 'Reads the board three moves deep. Guard your pieces.' },
];

interface Saved { seed: number; acts: Act[]; side: Color; foe: 'bot' | 'local'; level: number; god?: boolean; resigned?: Color }

function load(): Saved | null {
  try {
    const g = JSON.parse(localStorage.getItem(SAVE) || 'null') as Saved | null;
    return g && typeof g.seed === 'number' && Array.isArray(g.acts) ? g : null;
  } catch { return null; }
}

function store(g: Saved | null): void {
  try { if (g) localStorage.setItem(SAVE, JSON.stringify(g)); else localStorage.removeItem(SAVE); } catch { /* storage blocked */ }
}

const iconCache = new Map<SpellId, HTMLCanvasElement>();
function spellIcon(id: SpellId, scale: number): HTMLCanvasElement {
  let c = iconCache.get(id);
  if (!c) {
    const info = SPELLS[id];
    const im = img(8, 8);
    info.icon.forEach((row, y) => [...row].forEach((v, x) => { if (v !== '.') px(im, x, y, v === '#' ? info.color : info.light); }));
    iconCache.set(id, (c = toCanvas(im)));
  }
  return canvasOf(c, scale);
}

export function spellScreen(): Screen {
  const saved = load();
  return saved ? gameScreen(saved) : lobby();
}

// ---------- lobby ----------

function lobby(): Screen {
  let foe: number | 'local' = 1;
  let side: Side | 'random' = 'random';
  const grid = h('div.bot-grid');
  const detail = h('div.bot-detail.card');
  const sides = h('div.row.sides');

  function render(): void {
    grid.replaceChildren(
      ...FOES.map((f, i) => h('button.bot', { class: foe === i ? 'on' : '', onclick: () => { foe = i; render(); }, 'aria-pressed': String(foe === i) },
        portrait(f.bot, 3), h('b', {}, f.bot.name), h('span.rating', {}, f.title))),
      h('button.bot', { class: foe === 'local' ? 'on' : '', onclick: () => { foe = 'local'; render(); }, 'aria-pressed': String(foe === 'local') },
        h('div.two-up', {}, pieceIcon('k', 'w', 2), pieceIcon('k', 'b', 2)), h('b', {}, 'A friend'), h('span.rating', {}, 'Same board')));
    const f = foe === 'local' ? null : FOES[foe];
    detail.replaceChildren(f ? portrait(f.bot, 5) : h('div.two-up', {}, pieceIcon('k', 'w', 3), pieceIcon('k', 'b', 3)),
      h('div', {}, h('h2', {}, f ? `${f.bot.name}, ${f.title}` : 'Two players'), h('p', {}, f ? f.blurb : 'Pass the board back and forth. Both hands are face up.')));
    sides.replaceChildren(...(['w', 'random', 'b'] as const).map((s) => h('button.side-pick', { class: side === s ? 'on' : '', onclick: () => { side = s; render(); }, title: s === 'random' ? 'Random' : s === 'w' ? 'White' : 'Black' },
      s === 'random' ? h('span.q', {}, '?') : pieceIcon('k', s, 3))));
    sides.classList.toggle('hidden', foe === 'local');
    sideHead.classList.toggle('hidden', foe === 'local');
  }

  const sideHead = h('h3', {}, 'Play as');
  const el = h('div.screen.pick', {},
    topbar('Spell Chess'),
    h('div.panel.wide', {},
      h('p.spell-intro', {}, 'Chess with a hand of spells. Every capture draws a card from your deck of 18; hold up to three, and cast one a turn, before or after your move.'),
      grid, detail, sideHead, sides,
      h('details.io.spellbook', {}, h('summary', {}, 'The 18 spells'),
        h('div.spellbook-grid', {}, ...SPELL_IDS.map((id) => h('div.spell-entry', {}, spellIcon(id, 3), h('div', {}, h('b', {}, SPELLS[id].name), h('p', {}, SPELLS[id].text)))))),
      h('div.row.end', {}, h('span'), h('button.primary.big', {
        onclick: () => {
          const s: Color = foe === 'local' ? 'w' : side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
          store({ seed: (Math.random() * 2 ** 32) >>> 0, acts: [], side: s, foe: foe === 'local' ? 'local' : 'bot', level: foe === 'local' ? 0 : FOES[foe].level });
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        },
      }, 'Play'))));
  render();
  return { el };
}

// ---------- the game ----------

type Aim =
  | { kind: 'spell'; card: SpellId; casts: Cast[]; picks: number[] }
  | { kind: 'god'; power: 'flick' | 'anoint' | 'chicken'; targets: number[] };

function gameScreen(saved: Saved): Screen {
  const { seed, foe } = saved;
  const side = saved.side;
  const rival = FOES.find((f) => f.level === saved.level) ?? FOES[0];
  let acts = saved.acts.slice();
  let game: Game = replay(seed, acts);
  let resigned = saved.resigned ?? null;
  let god = Boolean(saved.god);
  let aim: Aim | null = null;
  let thinking = false;
  let token = 0;
  let timeStop = false;
  let typed = '';
  let shown = false;

  const host = h('div.board-host');
  const board = new BoardView(host);
  board.setTheme(currentTheme());
  const top = playerBar(), bottom = playerBar();
  const topHand = h('div.hand.top'), bottomHand = h('div.hand');
  const log = h('div.list-wrap.spell-log', { role: 'log' });
  const status = h('p.status-line');
  const bar = h('div.row.turn-bar');
  const backBtn = h('button', { onclick: takeback }, 'Takeback');
  const resignBtn = h('button.danger', { onclick: resign }, 'Resign');
  const godPanel = h('div.god.hidden');
  const after = h('div.row.after.hidden', {}, h('button.primary', { onclick: fresh }, 'New game'));

  const el = h('div.screen.play.spell', {},
    topbar('Spell Chess', (t) => board.setTheme(t)),
    h('div.game', {},
      h('div.stage', {}, top.el, topHand, host, bottomHand, bottom.el),
      h('aside.side.panel', {},
        h('div.botline', {}, foe === 'bot' ? portrait(rival.bot, 3) : h('div.two-up', {}, pieceIcon('k', 'w', 2), pieceIcon('k', 'b', 2)),
          h('div', {}, h('h2', {}, foe === 'bot' ? rival.bot.name : 'Two players'), h('p.hint', {}, foe === 'bot' ? `${rival.title} · ${rival.blurb}` : 'Both hands are face up.'))),
        log, status, bar,
        h('div.row', {}, backBtn, h('button', { onclick: () => board.flip() }, 'Flip'), resignBtn),
        godPanel, after)));

  board.onMove = (from, to, promotion) => { if (humanTurn()) apply({ k: 'm', from: sqIdx(from), to: sqIdx(to), promo: promotion as 'q' | undefined }); else render(false); };
  board.onPick = (sq) => pick(sqIdx(sq));

  // ----- who is who -----

  const me = (): Color => sideNow(game, side);
  const actor = (): Color => game.state.pending?.color ?? game.state.turn;
  const over = () => game.state.result ?? (resigned ? { winner: other(resigned), reason: 'resignation' } : null);
  const humanTurn = () => !over() && !thinking && (foe === 'local' || actor() === me());
  const label = (c: Color) => (foe === 'local' ? (c === 'w' ? 'White' : 'Black') : c === me() ? 'You' : rival.bot.name);

  function save(): void {
    store({ seed, acts, side, foe, level: saved.level, god, resigned: resigned ?? undefined });
  }

  // ----- actions -----

  function apply(a: Act, quiet = false): boolean {
    const before = game;
    const next = act(game, a);
    if (!next) { render(false); return false; }
    acts.push(a);
    game = next;
    aim = null;
    save();
    if (!quiet) {
      const count = (s: State) => s.board.reduce((n, p) => n + (p ? 1 : 0), 0);
      if (a.k === 'c') sound('right');
      else if (a.k === 'm') sound(inCheck(game.state, game.state.turn) ? 'check' : count(game.state) < count(before.state) ? 'capture' : 'move');
      const notes = game.log.slice(before.log.length).filter((l) => l.kind === 'note' && /draws|discards/.test(l.text)).map((l) => l.text.replace(/^(White|Black)/, (c) => (foe === 'local' ? c : label(c === 'White' ? 'w' : 'b'))).replace(/^You (draw|discard)s/, 'You $1'));
      if (notes.length) toast(notes.join(' '), 2600);
    }
    if (timeStop && !game.state.result && a.k !== 'g' && game.state.turn !== before.state.turn) {
      timeStop = false;
      const stopped = act(game, { k: 'g', p: 'pass' });
      if (stopped) { acts.push({ k: 'g', p: 'pass' }); game = stopped; save(); toast('ZA WARUDO. Time stops; the turn is yours again.', 2600); }
    }
    render(a.k !== 'm');
    if (game.state.result && !before.state.result) finish();
    else kick();
    return true;
  }

  /** Let the bot act if it is its turn. */
  function kick(): void {
    if (foe !== 'bot' || over() || actor() === me()) return;
    const mine = ++token;
    thinking = true;
    render();
    setTimeout(() => {
      if (mine !== token) return;
      const a: Action = botAction(game.state, LEVELS[saved.level] ?? LEVELS[0]);
      thinking = false;
      const done = apply(a.k === 'move' ? { k: 'm', from: a.move.from, to: a.move.to, promo: a.move.promo } : a.k === 'cast' ? { k: 'c', cast: a.cast } : a.k === 'discard' ? { k: 'd', spell: a.spell } : { k: 'e' });
      if (!done) render();
    }, 520 + Math.random() * 380);
  }

  function takeback(): void {
    const k = takebackPoint(seed, acts, foe === 'local' ? 'both' : side);
    if (k < 0) return;
    token++;
    thinking = false;
    acts = acts.slice(0, k);
    game = replay(seed, acts);
    aim = null;
    timeStop = false;
    save();
    render();
    kick();
  }

  function resign(): void {
    if (over()) return;
    const loser = foe === 'local' ? actor() : me();
    const m = modal(h('h2', {}, 'Resign?'), h('p', {}, `${label(other(loser))} will take the win.`),
      h('div.row.end', {}, h('button', { onclick: () => m.close() }, 'Keep playing'),
        h('button.danger', { onclick: () => { m.close(); token++; thinking = false; resigned = loser; save(); render(); finish(); } }, 'Resign')));
  }

  function fresh(): void {
    token++;
    store(null);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  function describe(): string {
    const o = over();
    if (!o) return '';
    if (!o.winner) return `Draw by ${o.reason}.`;
    if (foe === 'local') return `${label(o.winner)} wins by ${o.reason}.`;
    return o.winner === me() ? `You won by ${o.reason}!` : `${rival.bot.name} won by ${o.reason}.`;
  }

  function finish(): void {
    const o = over();
    if (!o || shown) return;
    shown = true;
    const res = o.winner === null ? 'draw' : foe === 'local' || o.winner === me() ? 'win' : 'lose';
    setTimeout(() => sound(res), 250);
    const m = modal(
      h('div.result', {}, foe === 'bot' ? portrait(rival.bot, 4) : pieceIcon('k', o.winner ?? 'w', 4),
        h('div', {}, h('h2', {}, o.winner === null ? 'Draw' : foe === 'local' ? `${label(o.winner)} wins` : o.winner === me() ? 'You win!' : `${rival.bot.name} wins`), h('p', {}, describe()))),
      h('div.row.end', {}, h('button', { onclick: () => m.close() }, 'Look at the board'), h('button.primary', { onclick: () => { m.close(); fresh(); } }, 'New game')));
  }

  // ----- aiming -----

  const FROST = [0, 1, 8, 9];
  const effective = (card: SpellId): SpellId | null => (card === 'echo' ? game.state.lastCast[other(actor())] : card);

  function startAim(card: SpellId, all: Cast[]): void {
    if (aim?.kind === 'spell' && aim.card === card) { aim = null; render(false); return; }
    let casts = all.filter((c) => c.spell === card);
    if (!casts.length) return;
    // Either end of a swap or a wall may be picked first.
    const eff = effective(card);
    if (eff === 'transpose' || eff === 'wall') casts = casts.concat(casts.map((c) => ({ ...c, at: [c.at[1], c.at[0]] })));
    aim = { kind: 'spell', card, casts, picks: [] };
    render(false);
  }

  function aimTargets(): number[] {
    if (!aim) return [];
    if (aim.kind === 'god') return aim.targets;
    const { casts, picks } = aim;
    if (effective(aim.card) === 'frost') {
      const foeColor = other(actor());
      const out = new Set<number>();
      for (const c of casts) for (const d of FROST) { const p = game.state.board[c.at[0] + d]; if (p && p.c === foeColor && p.t !== 'k') out.add(c.at[0] + d); }
      return [...out];
    }
    const out = new Set<number>();
    for (const c of casts) if (picks.every((p, i) => c.at[i] === p) && c.at.length > picks.length) out.add(c.at[picks.length]);
    return [...out];
  }

  function pick(sq: number): void {
    if (!aim || !humanTurn()) return;
    if (aim.kind === 'god') { godStrike(aim.power, sq); return; }
    if (effective(aim.card) === 'frost') {
      // The block around the picked piece that freezes the most.
      const foeColor = other(actor());
      const frozen = (c: Cast) => FROST.filter((d) => { const p = game.state.board[c.at[0] + d]; return p && p.c === foeColor && p.t !== 'k'; }).length;
      const best = aim.casts.filter((c) => FROST.some((d) => c.at[0] + d === sq)).sort((a, b) => frozen(b) - frozen(a))[0];
      if (best) apply({ k: 'c', cast: best });
      return;
    }
    aim.picks.push(sq);
    const { picks } = aim;
    const left = aim.casts.filter((c) => picks.every((p, i) => c.at[i] === p));
    const done = left.find((c) => c.at.length === picks.length);
    if (done) apply({ k: 'c', cast: { spell: done.spell, at: done.at, ...(done.as ? { as: done.as } : {}) } });
    else if (!left.length) { aim = null; render(false); }
    else render(false);
  }

  // ----- god mode -----

  function unlock(): void {
    if (god) return;
    god = true;
    save();
    sound('win');
    el.classList.add('ascend');
    setTimeout(() => el.classList.remove('ascend'), 1400);
    toast('⚡ GOD MODE ⚡  The board is yours to ruin.', 3200);
    render(false);
  }

  function fling(sq: number): void {
    const p = game.state.board[sq];
    if (!p) return;
    const r = board.squareRect(sqName(sq) as Square);
    const c = pieceIcon(p.t, p.c, 1);
    c.classList.add('flung');
    c.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:60;pointer-events:none;image-rendering:pixelated`;
    document.body.append(c);
    const dir = r.left + r.width / 2 < innerWidth / 2 ? -1 : 1;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const anim = c.animate(calm
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
        { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
        { transform: `translate(${dir * 90}px,${-innerHeight * 0.32}px) rotate(${dir * 500}deg) scale(1.7)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${dir * innerWidth * 0.55}px,${innerHeight * 0.9}px) rotate(${dir * 1500}deg) scale(0.15)`, opacity: 0 },
      ], { duration: calm ? 300 : 1250, easing: 'cubic-bezier(.3,.1,.7,1)' });
    anim.onfinish = () => c.remove();
  }

  function godStrike(power: 'flick' | 'anoint' | 'chicken', sq: number): void {
    if (power === 'flick') { fling(sq); sound('capture'); }
    else sound('right');
    apply({ k: 'g', p: power, sq }, true);
  }

  function meteor(): void {
    const foeColor = other(actor());
    const pool = game.state.board.map((p, i) => (p && p.c === foeColor && p.t !== 'k' ? i : -1)).filter((i) => i >= 0);
    if (!pool.length) { toast('Nothing left to hit. Have mercy.'); return; }
    const sq = pool[Math.floor(Math.random() * pool.length)];
    const r = board.squareRect(sqName(sq) as Square);
    const rock = h('div.meteor');
    rock.style.cssText = `left:${r.left + r.width / 4}px;top:${r.top + r.height / 4}px;width:${r.width / 2}px;height:${r.height / 2}px`;
    document.body.append(rock);
    const fall = rock.animate([{ transform: `translate(${-innerWidth * 0.4}px,${-innerHeight * 0.8}px) scale(2.2)` }, { transform: 'translate(0,0) scale(1)' }], { duration: 480, easing: 'ease-in' });
    fall.onfinish = () => {
      rock.remove();
      host.classList.add('shake');
      setTimeout(() => host.classList.remove('shake'), 450);
      godStrike('flick', sq);
    };
  }

  function swapSides(): void {
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    sound('castle');
    if (!calm) host.animate([{ transform: 'rotate(0deg) scale(1)' }, { transform: 'rotate(200deg) scale(0.55) translateY(-40px)', offset: 0.5 }, { transform: 'rotate(360deg) scale(1)' }], { duration: 700, easing: 'ease-in-out' });
    setTimeout(() => {
      apply({ k: 'g', p: 'swap' }, true);
      if (foe === 'bot') board.setOrientation(me());
      else board.flip();
      toast(foe === 'bot' ? `You flip the table. You are ${me() === 'w' ? 'White' : 'Black'} now.` : 'The table is flipped!', 2600);
    }, calm ? 0 : 350);
  }

  function renderGod(): void {
    godPanel.classList.toggle('hidden', !god);
    if (!god) return;
    const can = humanTurn() && !game.state.pending;
    const s = game.state;
    const foeColor = other(actor());
    const squares = (ok: (i: number) => boolean) => s.board.map((_, i) => i).filter(ok);
    const aimAt = (power: 'flick' | 'anoint' | 'chicken', targets: number[], none: string) => () => {
      if (!targets.length) { toast(none); return; }
      aim = aim?.kind === 'god' && aim.power === power ? null : { kind: 'god', power, targets };
      render(false);
    };
    const wish = h('select', { 'aria-label': 'Wish for a spell', disabled: !can, onchange: () => { const v = wish.value as SpellId; if (v) apply({ k: 'g', p: 'wish', spell: v, c: actor() }, true); } },
      h('option', { value: '' }, 'Wish for…'), ...SPELL_IDS.filter((id) => !s.hands[actor()].includes(id)).map((id) => h('option', { value: id }, SPELLS[id].name)));
    const btn = (text: string, title: string, on: () => void, lit = false) => h('button.small', { class: lit ? 'lit' : '', title, disabled: !can, onclick: on }, text);
    godPanel.replaceChildren(
      h('h3', {}, '⚡ God powers'),
      h('div.god-grid', {},
        btn('Flick', 'Flick an enemy piece into the abyss. Yes, even the king.', aimAt('flick', squares((i) => s.board[i]?.c === foeColor), 'Nothing to flick.'), aim?.kind === 'god' && aim.power === 'flick'),
        btn('Meteor', 'A rock from the sky lands on a random enemy piece.', meteor),
        btn('Flip table', 'Flip the table and swap sides with your opponent.', swapSides),
        btn('Coronation', 'Crown one of your pawns a queen where it stands.', aimAt('anoint', squares((i) => s.board[i]?.c === actor() && s.board[i]!.t === 'p'), 'No pawn to crown.'), aim?.kind === 'god' && aim.power === 'anoint'),
        btn('Demote', 'Turn an enemy piece into a pawn.', aimAt('chicken', squares((i) => { const p = s.board[i]; return !!p && p.c === foeColor && p.t !== 'k' && p.t !== 'p' && !p.ghost && rankOf(i) > 0 && rankOf(i) < 7; }), 'Nothing worth demoting.'), aim?.kind === 'god' && aim.power === 'chicken'),
        btn(timeStop ? 'Time stopped' : 'Time stop', 'Your opponent skips their next turn.', () => { timeStop = !timeStop; render(false); }, timeStop),
        btn('Disco', 'Purely cosmetic. Purely essential.', () => host.classList.toggle('disco'), host.classList.contains('disco')),
        wish));
  }

  // ----- drawing -----

  function boardOf(s: State): BoardState {
    const pieces: Pieces = new Map();
    const marks: Mark[] = [];
    const where = new Map<number, number>();
    s.board.forEach((p, i) => {
      if (!p) return;
      where.set(p.id, i);
      pieces.set(sqName(i) as Square, { type: p.t as PieceType, color: p.c, ghost: p.ghost });
      if (p.ghost) marks.push({ sq: sqName(i) as Square, kind: 'count', n: phantomTurnsLeft(s, p.id) });
    });
    const on = (id: number, kind: Mark['kind']) => { const i = where.get(id); if (i !== undefined) marks.push({ sq: sqName(i) as Square, kind }); };
    for (const f of s.fx.frost) for (const id of f.ids) on(id, 'frost');
    for (const w of s.fx.walls) for (const i of [w.a, w.b]) marks.push({ sq: sqName(i) as Square, kind: 'wall' });
    for (const a of s.fx.aegis) on(a.id, 'aegis');
    for (const t of s.fx.traps) marks.push({ sq: sqName(t.sq) as Square, kind: 'trap', n: trapTurnsLeft(s, t.sq) });
    for (const a of s.fx.alarm) { const k = findKing(s.board, a.on); if (k >= 0) marks.push({ sq: sqName(k) as Square, kind: 'alarm' }); }

    const dests = new Map<Square, Square[]>();
    if (humanTurn() && !aim && !s.pending) for (const m of legalMoves(s)) {
      const from = sqName(m.from) as Square;
      const list = dests.get(from) ?? [];
      if (!list.includes(sqName(m.to) as Square)) list.push(sqName(m.to) as Square);
      dests.set(from, list);
    }
    const mark = game.mark;
    const king = inCheck(s, s.turn) ? findKing(s.board, s.turn) : -1;
    return {
      pieces, dests, marks,
      lastMove: mark.length ? [sqName(mark[0]) as Square, sqName(mark[mark.length > 1 ? 1 : 0]) as Square] : null,
      check: king >= 0 ? (sqName(king) as Square) : null,
      targets: aim && humanTurn() ? aimTargets().map((i) => sqName(i) as Square) : null,
    };
  }

  function handOf(c: Color, casts: Cast[], atTop: boolean): HTMLElement[] {
    const s = game.state;
    const mine = humanTurn() && actor() === c;
    const discarding = mine && s.pending?.color === c;
    const cards = s.hands[c].map((id) => {
      const info = SPELLS[id];
      const copy = id === 'echo' ? s.lastCast[other(c)] : null;
      const castable = mine && !discarding && casts.some((x) => x.spell === id);
      const aimed = aim?.kind === 'spell' && aim.card === id && mine;
      return h('button.spell-card', {
        class: [castable || discarding ? 'ready' : 'dim', aimed ? 'on' : '', discarding ? 'discard' : '', atTop ? 'below' : ''].join(' '),
        'aria-disabled': String(!(castable || discarding)),
        'aria-label': `${info.name}. ${info.text}`,
        onclick: () => { if (discarding) apply({ k: 'd', spell: id }); else if (castable) startAim(id, casts); },
      },
      spellIcon(id, 3),
      h('span.name', {}, info.name, copy ? h('span.copy', {}, ` → ${SPELLS[copy].name}`) : null),
      h('span.tip', { role: 'tooltip' }, h('b', {}, info.name), info.text,
        copy ? h('i', {}, ` Copies ${SPELLS[copy].name}: ${SPELLS[copy].text}`) : null,
        mine && !castable && !discarding ? h('i', {}, s.flags.cast ? ' You have already cast a spell this turn.' : isSilenced(s, c) ? ' You are silenced this turn.' : ' No legal target right now.') : null));
    });
    const empty = Array.from({ length: Math.max(0, 3 - cards.length) }, () => h('span.spell-card.slot', { 'aria-hidden': 'true' }));
    const info = h('span.hand-info', {}, `Deck ${s.decks[c].length}`, isSilenced(s, c) ? h('span.tag.silenced', {}, 'Silenced') : null);
    return [...cards, ...empty, info];
  }

  function render(animate = true): void {
    const s = game.state;
    const o = over();
    const casts = humanTurn() && !s.pending ? legalCasts(s) : [];
    if (aim && !humanTurn()) aim = null;
    board.set(boardOf(s), animate);

    const low: Color = foe === 'local' ? board.side : me();
    const high = other(low);
    const name = (c: Color) => (foe === 'local' ? (c === 'w' ? 'White' : 'Black') : c === me() ? 'You' : rival.bot.name);
    const avatar = (c: Color) => (foe === 'local' ? pieceIcon('k', c, 3) : c === me() ? youAvatar() : portrait(rival.bot, 2));
    const turnOf = (c: Color) => (!o && actor() === c ? (thinking ? 'thinking…' : 'to play') : '');
    top.set({ avatar: avatar(high), name: name(high), sub: foe === 'bot' && high !== me() ? rival.title : '', status: turnOf(high) });
    bottom.set({ avatar: avatar(low), name: name(low), sub: foe === 'bot' && low !== me() ? rival.title : '', status: turnOf(low) });
    topHand.replaceChildren(...handOf(high, casts, true));
    bottomHand.replaceChildren(...handOf(low, casts, false));

    const lines = game.log.length ? game.log : [{ text: 'Capture a piece to draw your first spell.', kind: 'note' as const, by: 'w' as Color }];
    log.replaceChildren(...lines.map((l) => h('p', { class: `${l.kind} ${l.by}` }, l.text)));
    if (resigned) log.append(h('p.note', {}, `${label(resigned)} resigned.`));
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });

    const who = foe === 'local' ? `${label(actor())}: ` : '';
    const eff = aim?.kind === 'spell' ? effective(aim.card) : null;
    let text: string;
    if (o) text = describe();
    else if (!humanTurn()) text = `${rival.bot.name} is thinking…`;
    else if (s.pending) text = `${who}Hand is full. Pick one of the four cards to discard.`;
    else if (aim?.kind === 'god') text = aim.power === 'flick' ? 'Pick a piece to flick into the abyss.' : aim.power === 'anoint' ? 'Pick a pawn to crown.' : 'Pick a piece to demote to a pawn.';
    else if (aim && eff) text = `${SPELLS[aim.card].name}${aim.card === 'echo' ? ` (${SPELLS[eff].name})` : ''}: ${SPELLS[eff].aim[aim.picks.length] ?? 'Cast it now?'}`;
    else if (s.flags.moved) text = `${who}Cast a spell, or end your turn.`;
    else if (inCheck(s, s.turn)) text = `${who}Check!${legalMoves(s).length ? '' : ' Only a spell can save you.'}`;
    else if (!legalMoves(s).length) text = `${who}No legal move. Cast a spell to make one.`;
    else if (s.flags.cast) text = `${who}Spell cast. Now make your move.`;
    else text = foe === 'local' ? `${who}your move.` : casts.length ? 'Your move. You may cast one spell, before or after it.' : 'Your move.';
    status.textContent = text;

    const noTarget = aim?.kind === 'spell' && eff && SPELLS[eff].aim.length === 0 ? aim : null;
    bar.replaceChildren(...[
      noTarget ? h('button.primary', { onclick: () => apply({ k: 'c', cast: noTarget.casts[0] }) }, `Cast ${SPELLS[noTarget.card].name}`) : null,
      aim ? h('button', { onclick: () => { aim = null; render(false); } }, 'Cancel') : null,
      !aim && humanTurn() && s.flags.moved && !s.pending ? h('span.bar-label', {}, 'Cast a spell') : null,
      !aim && humanTurn() && s.flags.moved && !s.pending ? h('button.primary', { onclick: () => apply({ k: 'e' }) }, 'End turn') : null,
    ].filter((n): n is HTMLButtonElement | HTMLSpanElement => n !== null));
    bar.classList.toggle('hidden', !bar.childElementCount);

    backBtn.disabled = thinking || takebackPoint(seed, acts, foe === 'local' ? 'both' : side) < 0 || Boolean(game.state.result && !acts.length);
    resignBtn.disabled = Boolean(o);
    after.classList.toggle('hidden', !o);
    renderGod();
  }

  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape' && aim) { aim = null; render(false); return; }
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    typed = (typed + e.key.toLowerCase()).slice(-CODE.length);
    if (typed === CODE) unlock();
  };
  window.addEventListener('keydown', keys);

  board.setOrientation(foe === 'local' ? 'w' : me());
  render(false);
  kick();

  return {
    el,
    dispose() { token++; window.removeEventListener('keydown', keys); for (const n of document.querySelectorAll('.flung, .meteor')) n.remove(); },
  };
}
