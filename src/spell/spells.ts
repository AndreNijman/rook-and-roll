// The 18 spell cards: name, rules text, and an 8 x 8 icon drawn in two
// colours ('#' body, 'o' highlight), in the same pixel language as the pieces.

import type { SpellId } from './engine';

export interface SpellInfo {
  name: string;
  text: string;
  /** What to ask for while aiming, one line per target. */
  aim: string[];
  color: string;
  light: string;
  icon: string[];
}

export const SPELLS: Record<SpellId, SpellInfo> = {
  frost: {
    name: 'Frost Nova',
    text: 'Choose a 2x2 block. Enemy pieces in it (not the king) cannot move during your opponent\'s next turn. They still attack, give check and can be captured.',
    aim: ['Pick an enemy piece to freeze. Neighbours in the same 2x2 block freeze too.'],
    color: '#5ab0d8', light: '#e4f0f6',
    icon: ['...#....', '.#.#.#..', '..###...', '###o###.', '..###...', '.#.#.#..', '...#....', '........'],
  },
  phantom: {
    name: 'Phantom Knight',
    text: 'Place a ghostly knight on an empty square in your own half. It cannot arrive giving check or move this turn. It moves and captures like a knight and vanishes at the end of your third turn after casting. One at a time.',
    aim: ['Pick an empty square in your half for the Phantom Knight.'],
    color: '#a898d8', light: '#e8e0f8',
    icon: ['..#.#...', '..####..', '.#o###..', '######..', '##.###..', '...###..', '..#.#.#.', '.#.#.#..'],
  },
  alarm: {
    name: 'Royal Alarm',
    text: 'Your opponent\'s next move must be a king move (no castling), or a move by one of their pieces that is under attack. Only castable if their king has a legal move now. If it has none when their turn starts, the alarm does nothing.',
    aim: [],
    color: '#d8484a', light: '#f0d060',
    icon: ['...o....', '..###...', '.#####..', '.#####..', '.#####..', '#######.', '...o....', '........'],
  },
  transpose: {
    name: 'Transpose',
    text: 'Swap two of your own pieces (not the king) anywhere on the board. A pawn cannot end up on the first or last rank.',
    aim: ['Pick the first of your pieces to swap.', 'Pick the piece to swap it with.'],
    color: '#8ad05a', light: '#e8f8d0',
    icon: ['..#.....', '.######.', '..#...#.', '......#.', '.#......', '.#...#..', '.######.', '.....#..'],
  },
  blink: {
    name: 'Blink',
    text: 'Teleport one of your knights, bishops or rooks to an empty square within 2 squares in any direction. It cannot capture, and that piece cannot also make this turn\'s move.',
    aim: ['Pick a knight, bishop or rook to teleport.', 'Pick where it lands.'],
    color: '#e86a3a', light: '#f0d060',
    icon: ['o......o', '.#....#.', '..#..#..', '...oo...', '...oo...', '..#..#..', '.#....#.', 'o......o'],
  },
  wall: {
    name: 'Stone Wall',
    text: 'Place a wall on two empty squares side by side or one above the other. Nothing moves onto or through it; knights jump over. It stays until the start of your second turn after casting.',
    aim: ['Pick the first wall square.', 'Pick the square next to it.'],
    color: '#8a8490', light: '#c8c0cc',
    icon: ['........', '########', '#o.#o.#o', '########', '.#o.#o.#', '########', '#o.#o.#o', '########'],
  },
  aegis: {
    name: 'Aegis',
    text: 'Choose one of your pieces (not the king). It cannot be captured by a move or a spell until the start of your next turn.',
    aim: ['Pick the piece to shield.'],
    color: '#f0d060', light: '#fff8d0',
    icon: ['.######.', '.#o####.', '.#o####.', '.#o####.', '.######.', '..####..', '...##...', '........'],
  },
  surge: {
    name: 'Surge',
    text: 'Move one of your pawns one square straight forward onto an empty square. It cannot reach the last rank and cannot capture.',
    aim: ['Pick the pawn to push forward.'],
    color: '#8ad05a', light: '#e8f8d0',
    icon: ['...o....', '..ooo...', '.o.o.o..', '...#....', '..###...', '..###...', '.#####..', '........'],
  },
  shapeshift: {
    name: 'Shapeshift',
    text: 'Permanently turn one of your knights into a bishop, or one of your bishops into a knight.',
    aim: ['Pick a knight or bishop to transform.'],
    color: '#c878c8', light: '#f8d8f8',
    icon: ['.##.....', '####..o.', '.##..ooo', '......o.', '.o......', 'ooo..##.', '.o..####', '.....##.'],
  },
  revive: {
    name: 'Revive',
    text: 'Return one of your captured pawns to any empty square on your second rank. Only usable if you have lost a pawn.',
    aim: ['Pick an empty square on your second rank.'],
    color: '#e87a9a', light: '#ffe0e8',
    icon: ['........', '.##.##..', '#o#####.', '#o#####.', '.#####..', '..###...', '...#....', '........'],
  },
  gust: {
    name: 'Gust',
    text: 'Choose an enemy piece (not the king) next to one of your pieces. Push it one square directly away from your piece. The square must be on the board, empty and not a wall. A pawn cannot be pushed onto a back rank.',
    aim: ['Pick the enemy piece to push.', 'Pick the square it is blown onto.'],
    color: '#9ad0c0', light: '#e8fff8',
    icon: ['........', '.####...', '.....#..', '######..', '........', '#####.#.', '......#.', '.#####..'],
  },
  timeslip: {
    name: 'Time Slip',
    text: 'If your opponent\'s last move was a plain move by a piece other than the king (no capture, castling, promotion or en passant), put that piece back where it came from, if that square is empty.',
    aim: [],
    color: '#5ab0d8', light: '#f0d060',
    icon: ['.######.', '.#oooo#.', '..#oo#..', '...##...', '...##...', '..#..#..', '.#.oo.#.', '.######.'],
  },
  trap: {
    name: 'Rune Trap',
    text: 'Mark two empty squares side by side or one above the other. The first enemy piece (not the king) that ends a move on either, or is pushed onto one, is destroyed and the trap is spent. Both players see it; your own pieces are safe. It lasts until the end of your third turn after casting. One at a time.',
    aim: ['Pick the first square for the rune.', 'Pick the square next to it.'],
    color: '#7a6290', light: '#f0d060',
    icon: ['...#....', '..#o#...', '.#.o.#..', '#ooooo#.', '.#.o.#..', '..#o#...', '...#....', '........'],
  },
  smite: {
    name: 'Smite',
    text: 'Destroy one enemy pawn that is next to at least one of your pieces (diagonals count).',
    aim: ['Pick the enemy pawn to destroy.'],
    color: '#f0d060', light: '#fff8d0',
    icon: ['....##..', '...##...', '..##....', '.#####..', '...##...', '..##....', '.##.....', '.#......'],
  },
  leap: {
    name: 'Leap',
    text: 'Cast before your move. On this turn\'s move, one of your rooks or bishops may jump over exactly one piece of either colour (not a wall) and keep sliding, landing on an empty square or capturing.',
    aim: [],
    color: '#e86a3a', light: '#ffe0c0',
    icon: ['..####..', '.#....#.', '#......#', '#.....##', '......#.', '.oo.....', '.oo.....', '........'],
  },
  charm: {
    name: 'Charm',
    text: 'Move one enemy pawn one square straight forward onto an empty square. No double-step, no capture, and it cannot land on its promotion rank.',
    aim: ['Pick the enemy pawn to lure forward.'],
    color: '#e87a9a', light: '#ffe0e8',
    icon: ['..o...o.', '.o.o.o..', '........', '...#....', '..###...', '..###...', '.#####..', '........'],
  },
  silence: {
    name: 'Silence',
    text: 'Your opponent cannot cast spells during their next turn. All their active effects end at once: walls, traps, Aegis, Frost Nova, and their Phantom Knight vanishes.',
    aim: [],
    color: '#8a8490', light: '#d8484a',
    icon: ['o.....o.', '.o###o..', '.#o#o#..', '.##o##..', '.#o#o#..', '.o###o..', 'o.....o.', '........'],
  },
  echo: {
    name: 'Echo',
    text: 'Cast a copy of the last spell your opponent cast this game, with your own targets. An Echo of an Echo copies the original. Not castable if they have not cast a spell, or the copy has no legal target.',
    aim: [],
    color: '#a898d8', light: '#e8e0f8',
    icon: ['..##....', '.#..#...', '#.oo.#..', '#.oo.#..', '.#..#.o.', '..##.o.o', '......o.', '........'],
  },
};

export const SPELL_NAMES = Object.fromEntries(Object.entries(SPELLS).map(([k, v]) => [k, v.name])) as Record<SpellId, string>;
