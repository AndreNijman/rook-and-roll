# ROOK & ROLL

Pixel-art chess for [games.andrenijman.com](https://games.andrenijman.com), served at
[chess.andrenijman.com](https://chess.andrenijman.com).

- **Play the computer**: nine bots from about 250 to full-strength Stockfish, with hints,
  takebacks and a game that survives a reload.
- **Analysis**: live multi-line engine evaluation, PGN/FEN import and export.
- **Game review**: every move graded (best, excellent, good, inaccuracy, mistake, blunder)
  by lost win chance, with Lichess-style accuracy for both sides.
- Puzzles and online play are on the way.

Signed-in games accounts keep their profile (board theme, bot record, puzzle rating) on
the games guard at `/_guard/profile`; guests keep it in the browser.

## Developing

```sh
npm install
npm run dev      # http://localhost:5200
npm run check    # typecheck + tests
npm run build    # dist/, engine files included
npm run sheet -- sheet.png   # render every piece on every board theme
```

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
