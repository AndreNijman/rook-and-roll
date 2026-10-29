// Pieces of UI more than one screen uses.

import type { Move } from 'chess.js';
import { getProfile, loginUrl, me, saveProfile } from '../account';
import { THEMES, type BoardTheme } from '../art/board';
import { PIECE_TYPES, drawPiece, type Side } from '../art/pieces';
import { toCanvas } from '../art/pixel';
import { drawPortrait, drawStorm, type Hair } from '../art/portrait';
import { isMuted, setMuted } from '../audio';
import type { Bot } from '../bots';
import { CLASS_INFO, type MoveClass } from '../review';
import { canvasOf, h } from './dom';

export function currentTheme(): BoardTheme {
  return THEMES.find((t) => t.name === getProfile().theme) ?? THEMES[0];
}

/** Back link, title, and the account / sound / board-theme controls. */
export function topbar(title: string, onTheme?: (t: BoardTheme) => void): HTMLElement {
  const sound = h('button.small', { title: 'Sound', 'aria-label': 'Toggle sound' }, isMuted() ? 'Sound off' : 'Sound on');
  sound.onclick = () => { setMuted(!isMuted()); sound.textContent = isMuted() ? 'Sound off' : 'Sound on'; };
  const theme = h('button.small', { title: 'Board colours' }, `Board: ${currentTheme().name}`);
  theme.onclick = () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    saveProfile((p) => { p.theme = next.name; });
    theme.textContent = `Board: ${next.name}`;
    onTheme?.(next);
  };
  return h('header.topbar', {},
    title ? h('a.back', { href: '#' }, '◂ ROOK ', h('span.amp', {}, '&'), ' ROLL') : h('span.logo', {}, 'ROOK ', h('span.amp', {}, '&'), ' ROLL'),
    title ? h('h1', {}, title) : null,
    h('div.row.tools', {},
      theme, sound, account()));
}

/** The account chip; refreshed in place once the guard has answered. */
export function account(): HTMLElement {
  const s = me();
  return h('span.account', {}, s.signedIn
    ? h('span.tag.me', { title: 'Signed in to your games account' }, s.username)
    : h('a.small.button', { href: loginUrl(), target: '_top' }, 'Sign in'));
}

const portraitCache = new Map<string, HTMLCanvasElement>();

export function portrait(bot: Bot, scale: number): HTMLCanvasElement {
  let c = portraitCache.get(bot.id);
  if (!c) {
    c = toCanvas(bot.id === 'storm' ? drawStorm() : drawPortrait(bot.look, bot.hair, bot.rating));
    portraitCache.set(bot.id, c);
  }
  return canvasOf(c, scale, 'sprite portrait');
}

const SKIN = ['#f4c8a0', '#d8a070', '#b07850', '#8a5a3a', '#f0d0b8', '#c89070'];
const HAIR = ['#5a3a28', '#e8a040', '#26181e', '#c8c0e0', '#d8484a', '#8a6a48'];
const SHIRT = ['#8ad05a', '#5ab0d8', '#f0d060', '#d8484a', '#7a6290', '#efe4cc'];
const STYLES: Hair[] = ['short', 'long', 'bun', 'spiky', 'bald', 'hood'];

/** A pixel portrait for an online player, the same for the same name every time. */
export function playerPortrait(name: string, scale: number): HTMLCanvasElement {
  let c = portraitCache.get(`player:${name}`);
  if (!c) {
    let x = 2166136261;
    for (const ch of name) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
    const pick = <T>(a: T[], shift: number) => a[(x >>> shift) % a.length];
    c = toCanvas(drawPortrait([pick(SKIN, 0), pick(HAIR, 5), pick(SHIRT, 10)], pick(STYLES, 15), x % 9973));
    portraitCache.set(`player:${name}`, c);
  }
  return canvasOf(c, scale, 'sprite portrait');
}

export function pieceIcon(type: string, side: Side, scale = 1): HTMLCanvasElement {
  return canvasOf(toCanvas(drawPiece(type as (typeof PIECE_TYPES)[number], side)), scale);
}

/** Player strip beside the board: avatar, name, captured pieces. */
export function playerBar(): { el: HTMLElement; set(o: { avatar?: Node; name: string; sub?: string; captured?: string[]; capturedSide?: Side; lead?: number; status?: string }): void } {
  const avatar = h('div.avatar'), name = h('b'), sub = h('span.sub'), caps = h('div.caps'), status = h('span.status');
  const el = h('div.bar', {}, avatar, h('div.who', {}, h('div', {}, name, ' ', sub), caps), status);
  return {
    el,
    set(o) {
      if (o.avatar) avatar.replaceChildren(o.avatar);
      name.textContent = o.name;
      sub.textContent = o.sub ?? '';
      status.textContent = o.status ?? '';
      caps.classList.toggle('dark', o.capturedSide === 'b' && Boolean(o.captured?.length));
      caps.replaceChildren(...(o.captured ?? []).map((t) => pieceIcon(t, o.capturedSide ?? 'b')), o.lead ? h('span.lead', {}, `+${o.lead}`) : '');
    },
  };
}

export function youAvatar(): HTMLElement {
  return h('div.you', {}, (me().username ?? 'You').slice(0, 1).toUpperCase());
}

/** Numbered move list; clicking a move shows that position. */
export function moveList(moves: Pick<Move, 'san' | 'color'>[], ply: number, onPick: (ply: number) => void, classes?: MoveClass[], firstSide: Side = 'w'): HTMLElement {
  const list = h('div.moves', { role: 'list' });
  const offset = firstSide === 'b' ? 1 : 0;
  if (offset) list.append(h('span.num', {}, '1.'), h('span.cell.empty', {}, '…'));
  moves.forEach((m, i) => {
    if ((i + offset) % 2 === 0) list.append(h('span.num', {}, `${Math.floor((i + offset) / 2) + 1}.`));
    const cls = classes?.[i];
    const cell = h('button.cell', { class: i + 1 === ply ? 'on' : '', onclick: () => onPick(i + 1), role: 'listitem' },
      m.san,
      cls && cls !== 'best' && cls !== 'excellent' && cls !== 'good' ? h('span.mark', { style: `color:${CLASS_INFO[cls].color}` }, CLASS_INFO[cls].mark) : null);
    list.append(cell);
  });
  requestAnimationFrame(() => list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }));
  return list;
}

export function modal(...children: (Node | string)[]): { el: HTMLElement; close(): void } {
  const el = h('div.modal', {}, h('div.panel.small', {}, ...children));
  document.body.append(el);
  return { el, close: () => el.remove() };
}
