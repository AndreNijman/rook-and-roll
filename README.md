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

## Engine

Stockfish 19 (lite, single-threaded WebAssembly build) from the
[`stockfish`](https://www.npmjs.com/package/stockfish) npm package. It is not vendored:
the Vite build copies it to `dist/engine/` with its licence. Stockfish is GPLv3 and runs
as a separate program in a Web Worker, talking UCI; its source is at
<https://github.com/official-stockfish/Stockfish>.

## Deploying

Every push to `main` is checked, built and published to GitHub Pages by
`.github/workflows/pages.yml`.
