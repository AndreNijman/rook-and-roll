// Choose a bot and a colour.

import { getProfile } from '../account';
import type { Side } from '../art/pieces';
import { BOTS, type Bot } from '../bots';
import { h } from '../ui/dom';
import { pieceIcon, portrait, topbar } from '../ui/parts';
import type { Screen } from '../main';
import { savedGame, startGame } from './play';

export function pickScreen(): Screen {
  let chosen: Bot = BOTS[2];
  let side: Side | 'random' = 'random';

  const detail = h('div.bot-detail.card');
  const grid = h('div.bot-grid');
  const sides = h('div.row.sides');

  function record(bot: Bot): string {
    const r = getProfile().bots[bot.id];
    return r ? `${r.w}W ${r.l}L ${r.d}D` : 'Not played yet';
  }

  function render(): void {
    grid.replaceChildren(...BOTS.map((b) => h('button.bot', { class: b === chosen ? 'on' : '', onclick: () => { chosen = b; render(); }, 'aria-pressed': String(b === chosen) },
      portrait(b, 3), h('b', {}, b.name), h('span.rating', {}, String(b.rating)))));
    detail.replaceChildren(portrait(chosen, 5),
      h('div', {}, h('h2', {}, chosen.name), h('p.rating', {}, `Rated about ${chosen.rating}`), h('p', {}, chosen.blurb), h('p.hint', {}, `Your record: ${record(chosen)}`)));
    sides.replaceChildren(
      ...(['w', 'random', 'b'] as const).map((s) => h('button.side-pick', { class: side === s ? 'on' : '', onclick: () => { side = s; render(); }, title: s === 'random' ? 'Random' : s === 'w' ? 'White' : 'Black' },
        s === 'random' ? h('span.q', {}, '?') : pieceIcon('k', s, 3))));
  }

  const resume = savedGame();
  const el = h('div.screen.pick', {},
    topbar('Play the computer'),
    h('div.panel.wide', {},
      resume ? h('div.resume.card', {}, h('span', {}, `You have a game in progress against ${BOTS.find((b) => b.id === resume.bot)?.name}.`), h('a.button.primary', { href: '#play' }, 'Continue')) : null,
      grid, detail,
      h('h3', {}, 'Play as'), sides,
      h('div.row.end', {}, h('span'), h('button.primary.big', {
        onclick: () => {
          const s: Side = side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
          startGame(chosen, s);
          location.hash = '#play';
        },
      }, 'Play'))));
  render();
  return { el };
}
