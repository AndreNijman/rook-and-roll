import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Stockfish (GPLv3) is not vendored: the lite single-threaded build comes from
// the npm package and is served at /engine/ next to the game. Single-threaded
// because GitHub Pages cannot send the COOP/COEP headers threads need, and
// the game runs inside the hub's frame anyway.
const ENGINE = ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm'];
const engineDir = join(dirname(createRequire(import.meta.url).resolve('stockfish/package.json')), 'bin');
const licence = join(engineDir, '..', 'Copying.txt');

function engine(): Plugin {
  return {
    name: 'stockfish-engine',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/^\/engine\/([\w.-]+)$/)?.[1];
        if (!name || !ENGINE.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(engineDir, name)));
      });
    },
    writeBundle(options) {
      const out = join(options.dir!, 'engine');
      mkdirSync(out, { recursive: true });
      for (const name of ENGINE) copyFileSync(join(engineDir, name), join(out, name));
      copyFileSync(licence, join(out, 'COPYING.txt'));
    },
  };
}

// The client is a static bundle (GitHub Pages at chess.andrenijman.com).
export default defineConfig({
  root: 'src/client',
  base: './',
  publicDir: '../../public',
  plugins: [engine()],
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5200, host: true },
});
