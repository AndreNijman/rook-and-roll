// The connection to the online relay. In production the page talks to
// games-guard at /_guard/chess-ws on its own host, which knows the signed-in
// account; `VITE_RELAY=ws://localhost:8797/ws npm run dev` talks to
// `npm run relay:dev` directly. Guests carry a random token of their own so a
// reload or a second tab is still the same player.

const GUEST = 'rookroll:guest';

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
/** Used when storage is blocked: the same player for this page only. */
let pageToken = '';

function guestToken(): string {
  try {
    let t = localStorage.getItem(GUEST);
    if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
      t = randomToken();
      localStorage.setItem(GUEST, t);
    }
    return t;
  } catch {
    return (pageToken ||= randomToken());
  }
}

function relayUrl(query: Record<string, string>): string {
  const base = import.meta.env.VITE_RELAY as string | undefined
    || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_guard/chess-ws`;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set('guest', guestToken());
  return url.href;
}

export type Link = 'connecting' | 'open' | 'lost';

/** A socket that reconnects until closed, and keeps itself alive with pings. */
export class Relay<In, Out> {
  private ws: WebSocket | null = null;
  private tries = 0;
  private closed = false;
  private ping = 0;
  private retry = 0;
  onMessage: (m: In) => void = () => {};
  onLink: (l: Link) => void = () => {};
  /** The server said this will never work (an unknown game): stop retrying. */
  onFatal: (reason: string) => void = () => {};

  constructor(private query: Record<string, string>) {
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.onLink('connecting');
    const ws = new WebSocket(relayUrl(this.query));
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.onLink('open');
      this.ping = window.setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20_000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try { this.onMessage(JSON.parse(String(e.data)) as In); } catch { /* not ours */ }
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (this.closed || this.ws !== ws) return;
      if (e.code === 4404) { this.closed = true; this.onFatal(e.reason); return; }
      this.onLink('lost');
      this.retry = window.setTimeout(() => this.open(), Math.min(5000, 400 * 2 ** this.tries++));
    };
  }

  send(m: Out): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.ws?.close();
  }
}
