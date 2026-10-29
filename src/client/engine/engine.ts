// Stockfish in a Web Worker, one search at a time. A new search stops the
// one running (its promise still resolves, with whatever it had found), so
// callers can fire and forget as the position changes.

import { parseInfo, type Line } from './uci';

export interface SearchOptions {
  depth?: number;
  movetime?: number;
  multipv?: number;
  /** UCI options set before the search, e.g. Skill Level or UCI_Elo. */
  options?: Record<string, string | number | boolean>;
  /** Called with every improving set of lines, for live analysis. */
  onInfo?: (lines: Line[]) => void;
}

export interface SearchResult { bestmove: string; lines: Line[] }

interface Job extends SearchOptions {
  fen: string;
  resolve: (r: SearchResult) => void;
  lines: Line[];
}

export const ENGINE_URL = 'engine/stockfish-19-lite-single.js';

export class Engine {
  private worker: Worker;
  private ready: Promise<void>;
  private current: Job | null = null;
  private queue: Job | null = null;
  private options = new Map<string, string>();

  constructor(url = new URL(ENGINE_URL, document.baseURI).href) {
    this.worker = new Worker(url);
    this.ready = new Promise((resolve) => {
      const onReady = (e: MessageEvent) => {
        if (e.data === 'readyok') { this.worker.removeEventListener('message', onReady); resolve(); }
      };
      this.worker.addEventListener('message', onReady);
    });
    this.worker.addEventListener('message', (e) => this.onLine(String(e.data)));
    this.send('uci');
    this.send('isready');
  }

  search(fen: string, opts: SearchOptions = {}): Promise<SearchResult> {
    return new Promise((resolve) => {
      // Only the newest waiting search matters; an older one resolves empty.
      this.queue?.resolve({ bestmove: '', lines: [] });
      this.queue = { ...opts, fen, resolve, lines: [] };
      if (this.current) this.send('stop');
      else void this.next();
    });
  }

  stop(): void {
    this.queue?.resolve({ bestmove: '', lines: [] });
    this.queue = null;
    if (this.current) this.send('stop');
  }

  newGame(): void { this.send('ucinewgame'); }

  terminate(): void { this.stop(); this.worker.terminate(); }

  private async next(): Promise<void> {
    const job = this.queue;
    if (!job || this.current) return;
    this.queue = null;
    this.current = job;
    await this.ready;
    this.setOption('MultiPV', job.multipv ?? 1);
    for (const [k, v] of Object.entries(job.options ?? {})) this.setOption(k, v);
    this.send(`position fen ${job.fen}`);
    const limits = [job.depth ? `depth ${job.depth}` : '', job.movetime ? `movetime ${job.movetime}` : ''].filter(Boolean);
    this.send(`go ${limits.join(' ') || 'depth 12'}`);
  }

  private setOption(name: string, value: string | number | boolean): void {
    const v = String(value);
    if (this.options.get(name) === v) return;
    this.options.set(name, v);
    this.send(`setoption name ${name} value ${v}`);
  }

  private onLine(text: string): void {
    const job = this.current;
    if (!job) return;
    if (text.startsWith('info ')) {
      const line = parseInfo(text);
      if (!line) return;
      job.lines[line.multipv - 1] = line;
      // Report only once the first line of a new depth has arrived, so the
      // set is never a mix of a fresh line 1 and a stale line 3.
      if (line.multipv === (job.multipv ?? 1)) job.onInfo?.(job.lines.filter(Boolean));
      return;
    }
    if (text.startsWith('bestmove')) {
      const bestmove = text.split(/\s+/)[1] ?? '';
      this.current = null;
      job.resolve({ bestmove: bestmove === '(none)' ? '' : bestmove, lines: job.lines.filter(Boolean) });
      void this.next();
    }
  }

  private send(cmd: string): void { this.worker.postMessage(cmd); }
}
