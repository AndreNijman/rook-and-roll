// ROOK & ROLL: screens are routed by the URL hash, so the browser's back
// button works inside the hub's frame and links can point at a mode.

import './style.css';
import { connect } from './account';
import { THEMES, drawSquare } from './art/board';
import { drawPiece } from './art/pieces';
import { blit, img, toCanvas } from './art/pixel';
import { analysisScreen } from './modes/analysis';
import { pickScreen } from './modes/pick';
import { onlineGame, onlineLobby } from './modes/online';
import { puzzlesScreen } from './modes/puzzles';
import { playScreen, savedGame } from './modes/play';
import { BOTS } from './bots';
import { canvasOf, h } from './ui/dom';
import { account, portrait, topbar } from './ui/parts';

export interface Screen { el: HTMLElement; dispose?(): void }

const root = document.getElementById('app')!;
let current: Screen | null = null;

function show(screen: Screen): void {
  current?.dispose?.();
  for (const m of document.querySelectorAll('.modal')) m.remove();
  current = screen;
  root.replaceChildren(screen.el);
  window.scrollTo(0, 0);
}

function route(): void {
  const hash = location.hash.slice(1);
  if (hash === 'bots') return show(pickScreen());
  if (hash === 'play') return show(playScreen() ?? pickScreen());
  if (hash === 'analysis') return show(analysisScreen(false));
  if (hash === 'review') return show(analysisScreen(true));
  if (hash === 'puzzles') return show(puzzlesScreen(false));
  if (hash === 'rush') return show(puzzlesScreen(true));
  if (hash === 'online') return show(onlineLobby());
  const game = hash.match(/^online\/([a-z0-9]{8})$/);
  if (game) return show(onlineGame(game[1]));
  show(homeScreen());
}

function tileArt(kind: string): HTMLCanvasElement {
  // A 3 x 2 patch of board with a piece or two on it, per mode.
  const im = img(48, 32);
  const t = THEMES[['bots', 'online', 'puzzles', 'analysis'].indexOf(kind) % THEMES.length];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) blit(im, drawSquare(t, (x + y) % 2 === 0, x * 3 + y), x * 16, y * 16);
  const put: Record<string, [string, 'w' | 'b', number, number][]> = {
    bots: [['n', 'w', 0, 16], ['k', 'b', 32, 0]],
    online: [['q', 'w', 0, 16], ['q', 'b', 32, 0]],
    puzzles: [['r', 'w', 16, 16], ['k', 'b', 16, 0]],
    analysis: [['b', 'w', 0, 0], ['p', 'b', 32, 16]],
  };
  for (const [type, side, x, y] of put[kind]) blit(im, drawPiece(type as 'p', side), x, y);
  return canvasOf(toCanvas(im), 3);
}

function homeScreen(): Screen {
  const resume = savedGame();
  const tile = (kind: string, title: string, text: string, soon = false) =>
    h('a.tile', { href: `#${kind === 'bots' && resume ? 'play' : kind}`, class: soon ? 'soon' : '' },
      tileArt(kind), h('b', {}, title), h('span', {}, text), soon ? h('span.tag', {}, 'Soon') : null);
  const el = h('div.screen.home', {},
    topbar(''),
    h('main.home-main', {},
      h('div.hero', {},
        h('div.lineup', {}, ...BOTS.slice(0, 6).map((b) => portrait(b, 3))),
        h('h1.title', {}, 'ROOK ', h('span.amp', {}, '&'), ' ROLL'),
        h('p.tagline', {}, 'Pixel chess. Play people and bots, solve puzzles, review your games.')),
      h('nav.tiles', {},
        tile('bots', resume ? 'Continue game' : 'Play the computer', resume ? `Your game against ${BOTS.find((b) => b.id === resume.bot)?.name} is waiting.` : 'Nine bots, from beginner to full-strength Stockfish.'),
        tile('online', 'Play online', 'Rated games against people, or a link for a friend.'),
        tile('puzzles', 'Puzzles', 'Rated tactics that keep pace with you, and Puzzle Rush against the clock.'),
        tile('analysis', 'Analysis', 'Explore positions with the engine, import a game, review it.')),
      h('p.credits', {}, 'Engine: ', h('a', { href: 'https://stockfishchess.org', target: '_blank', rel: 'noopener' }, 'Stockfish'), ' (GPLv3, ', h('a', { href: 'engine/COPYING.txt', target: '_blank' }, 'licence'), ').')));
  return { el };
}

window.addEventListener('hashchange', route);
route();
void connect().then((replaced) => {
  // A newer profile from the account changes the theme and records shown;
  // the bot game itself lives in this browser, so re-showing it is safe.
  if (replaced) route();
  else for (const slot of document.querySelectorAll('.account')) slot.replaceWith(account());
});
