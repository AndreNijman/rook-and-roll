# ROOK & ROLL

Pixel-art chess for [games.andrenijman.com](https://games.andrenijman.com), served at
[chess.andrenijman.com](https://chess.andrenijman.com).

- **Play the computer**: nine bots from about 250 to full-strength Stockfish, with hints,
  takebacks and a game that survives a reload.
- **Analysis**: live multi-line engine evaluation, PGN/FEN import and export.
- **Game review**: every move graded (best, excellent, good, inaccuracy, mistake, blunder)
  by lost win chance, with Lichess-style accuracy for both sides.
- **Puzzles**: about 5,000 puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles)
  (CC0), rated with Glicko-2, plus Puzzle Rush (three minutes, three strikes).
  Rebuild the shards with `zstd -dc lichess_db_puzzle.csv.zst | npx tsx tools/puzzles.ts public/puzzles`.
- **Online**: quick matches in ten time controls (rated with Glicko-2 for signed-in
  accounts, per bullet/blitz/rapid/classical), friend links, spectators, draw offers,
  rematches and server-kept clocks.

- **Spell Chess**: chess with a hand of spell cards, against a three-strength bot or a
  friend on the same board, or online (quick match or a friend link, always casual). Every
  capture draws from a personal deck of 18 spells; hold three, cast one a turn.

Signed-in games accounts keep their profile (board theme, bot record, puzzle rating) on
the games guard at `/_guard/profile`; guests keep it in the browser.

## Developing

```sh
npm install
npm run dev      # http://localhost:5200
npm run check    # typecheck + tests
npm run build    # dist/, engine files included
npm run sheet -- sheet.png   # render every piece on every board theme
npm run relay:dev                         # the online relay on :8797
VITE_RELAY=ws://localhost:8797/ws npm run dev   # client against it
npm run test:online                       # drive the relay with fake players
npx tsx tools/spell-balance.ts            # bot-vs-bot Spell Chess games, per-spell numbers
```

## Online relay

`src/worker/index.ts` is a Cloudflare Worker (`chess-relay`) with two Durable Objects:
`Lobby` (the quick-match queue, friend links and the ratings table) and `Game` (one per
game: moves checked with chess.js, clocks kept by the server, flag-fall by alarm). The rules
and clocks live in `src/server/match.ts` so the tests can drive them.

The relay has no public route. games-guard reaches it over a service binding from
`/_guard/chess-ws` on chess.andrenijman.com and names the signed-in account in headers,
so deploy the relay (`wrangler deploy --env production`) before the guard that binds to it.

The board, pieces and portraits are drawn in code (`src/client/art/`), pixel by pixel.

## Spell Chess

The rules are in `src/spell/`, with no DOM and no chess.js (walls, phantom pieces and
spells that move or remove pieces need their own move generator):

- `engine.ts`: the state and every rule. Decks, hands, active effects, durations, the last
  spell cast and the shuffle's random state are all inside the JSON-serialisable `State`.
- `spells.ts`: card names, rules text and icons.
- `bot.ts`: a small alpha-beta search; spells are scored cast vs. don't cast.
- `game.ts`: a game as a seed plus a list of actions. Replaying the list gives takebacks,
  the saved game and the move log, and is the record an online relay would pass around.

Online, a game's `variant` is `spell`: the relay keeps the seed and the action list, checks
every action with the same engine (`Match.act`), and sends both to the players. Spell Chess
has its own quick-match queue and is never rated. God powers are refused by the relay.

The screen is `src/client/modes/spell.ts`. The board view only gained optional overlays
(`marks`, `targets`, translucent pieces), which the other modes never set.

## Engine

Stockfish 19 (lite, single-threaded WebAssembly build) from the
[`stockfish`](https://www.npmjs.com/package/stockfish) npm package. It is not vendored:
the Vite build copies it to `dist/engine/` with its licence. Stockfish is GPLv3 and runs
as a separate program in a Web Worker, talking UCI; its source is at
<https://github.com/official-stockfish/Stockfish>.

## Deploying

Every push to `main` is checked, built and published to GitHub Pages by
`.github/workflows/pages.yml`.
