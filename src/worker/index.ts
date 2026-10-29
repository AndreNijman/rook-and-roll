// ROOK & ROLL online relay: a Cloudflare Worker plus Durable Objects.
//   GET /ws?lobby=1[&guest=T]   the quick-match queue and friend-game links (Lobby)
//   GET /ws?game=ID[&guest=T]   one game: players, spectators, clocks (Game)
//   GET /health                 monitoring
//
// The relay has no public route. games-guard reaches it over a service
// binding from /_guard/chess-ws on chess.andrenijman.com, after its own
// device and account checks, and names the signed-in account in
// X-Chess-Account / X-Chess-Name. Those headers are trusted only because
// nothing else can reach this Worker: never give it a route or workers.dev
// URL without first replacing that trust. Guests bring a random token of
// their own (?guest=), which only ever leaves here hashed.
//
// Both objects use the hibernation API: chess has no tick loop, so an idle
// game costs nothing, and each game's state is stored after every change.

import { DurableObject } from 'cloudflare:workers';
import { Match, type MatchState, type Seat } from '../server/match';
import { current, fresh, rateGame, shown, type Stored } from '../server/ratings';
import {
  CATEGORIES, GAME_ID, categoryOf, isTimeControl,
  type Category, type GameClientMsg, type GameServerMsg, type LobbyClientMsg, type LobbyServerMsg,
  type PlayerInfo, type Side, type TimeControl,
} from '../shared/online';

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  GAMES: DurableObjectNamespace<Game>;
}

const MAX_FRAME = 2048;
const GUEST = /^[A-Za-z0-9_-]{16,64}$/;

interface Who { pid: string; name: string; account: boolean }

async function hash(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function identify(request: Request, url: URL): Promise<Who | null> {
  const account = request.headers.get('X-Chess-Account');
  if (account) {
    const name = (request.headers.get('X-Chess-Name') || 'Player').slice(0, 24);
    return { pid: `a${(await hash(`account:${account}`)).slice(0, 20)}`, name, account: true };
  }
  const guest = url.searchParams.get('guest');
  if (!guest || !GUEST.test(guest)) return null;
  const h = await hash(`guest:${guest}`);
  return { pid: `g${h.slice(0, 20)}`, name: `Guest ${String(parseInt(h.slice(20, 28), 16) % 10000).padStart(4, '0')}`, account: false };
}

const whoHeaders = (w: Who) => ({ 'X-Pid': w.pid, 'X-Name': w.name, 'X-Account': w.account ? '1' : '0' });
const whoOf = (request: Request): Who => ({
  pid: request.headers.get('X-Pid') || '',
  name: request.headers.get('X-Name') || 'Player',
  account: request.headers.get('X-Account') === '1',
});

const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('global'));
const game = (env: Env, id: string) => env.GAMES.get(env.GAMES.idFromName(id));

function newId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => a[b % a.length]).join('');
}

function send(ws: WebSocket, msg: GameServerMsg | LobbyServerMsg): void {
  try { ws.send(JSON.stringify(msg)); } catch { /* closing */ }
}

function parse<T>(data: string | ArrayBuffer): T | null {
  if (typeof data !== 'string' || data.length > MAX_FRAME) return null;
  try { return JSON.parse(data) as T; } catch { return null; }
}

function upgrade(): [WebSocket, WebSocket] {
  const pair = new WebSocketPair();
  return [pair[0], pair[1]];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
    const who = await identify(request, url);
    if (!who) return new Response('Who are you?', { status: 400 });
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(whoHeaders(who))) headers.set(k, v);
    const inner = new Request(request.url, { headers });
    if (url.searchParams.has('lobby')) return lobby(env).fetch(inner);
    const id = url.searchParams.get('game') || '';
    if (!GAME_ID.test(id)) return new Response('No such game', { status: 404 });
    return game(env, id).fetch(inner);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- lobby

interface Seek { tc: TimeControl; rated: boolean; since: number; rating: number }
interface LobbyTag extends Who { seek?: Seek }

/** Rated seekers are paired within this many points, widening the longer they wait. */
const spread = (waitedMs: number) => 150 + waitedMs / 100;
const MATCH_EVERY_MS = 2000;

export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ratings (
      pid TEXT NOT NULL, cat TEXT NOT NULL, rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
      games INTEGER NOT NULL, updated INTEGER NOT NULL, name TEXT, PRIMARY KEY (pid, cat))`);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rated_games (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private stored(pid: string, cat: Category, now: number): Stored | null {
    const row = this.ctx.storage.sql.exec<{ rating: number; rd: number; vol: number; games: number; updated: number }>(
      'SELECT rating, rd, vol, games, updated FROM ratings WHERE pid = ? AND cat = ?', pid, cat).toArray()[0];
    return row ? current(row, now) : null;
  }

  private store(pid: string, cat: Category, r: Stored, name: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ratings (pid, cat, rating, rd, vol, games, updated, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pid, cat) DO UPDATE SET rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
         games = excluded.games, updated = excluded.updated, name = excluded.name`,
      pid, cat, r.rating, r.rd, r.vol, r.games, r.updated, name);
  }

  /** A player's rating as shown in a game, for accounts only. */
  async ratingOf(pid: string, cat: Category): Promise<PlayerInfo['rating']> {
    return shown(this.stored(pid, cat, Date.now()) ?? fresh(Date.now()));
  }

  /** Rate a finished game once; `score` is White's. */
  async rate(id: string, cat: Category, w: Seat, b: Seat, score: number): Promise<Record<Side, { before: number; after: number }> | null> {
    const now = Date.now();
    if (this.ctx.storage.sql.exec('SELECT 1 FROM rated_games WHERE id = ?', id).toArray().length) return null;
    const rw = this.stored(w.pid, cat, now) ?? fresh(now), rb = this.stored(b.pid, cat, now) ?? fresh(now);
    const next = rateGame(rw, rb, score, now);
    this.store(w.pid, cat, next.w, w.info.name);
    this.store(b.pid, cat, next.b, b.info.name);
    this.ctx.storage.sql.exec('INSERT INTO rated_games (id, at) VALUES (?, ?)', id, now);
    return {
      w: { before: Math.round(rw.rating), after: Math.round(next.w.rating) },
      b: { before: Math.round(rb.rating), after: Math.round(next.b.rating) },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const who = whoOf(request);
    const [client, server] = upgrade();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ...who } satisfies LobbyTag);
    const now = Date.now();
    const ratings: Extract<LobbyServerMsg, { t: 'hello' }>['ratings'] = {};
    if (who.account) for (const cat of CATEGORIES) {
      const r = this.stored(who.pid, cat, now);
      if (r) ratings[cat] = { ...shown(r), games: r.games };
    }
    send(server, { t: 'hello', name: who.name, account: who.account, ratings });
    this.counts();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const msg = parse<LobbyClientMsg>(data);
    if (!msg) return;
    const tag = ws.deserializeAttachment() as LobbyTag;
    if (msg.t === 'cancel') {
      delete tag.seek;
      ws.serializeAttachment(tag);
    } else if (msg.t === 'seek' && isTimeControl(msg.tc)) {
      const rated = Boolean(msg.rated) && tag.account;
      const rating = rated ? (this.stored(tag.pid, categoryOf(msg.tc), Date.now())?.rating ?? 1500) : 1500;
      // One seek per player, whichever tab it came from.
      for (const other of this.ctx.getWebSockets()) {
        const t = other.deserializeAttachment() as LobbyTag;
        if (other !== ws && t.pid === tag.pid && t.seek) { delete t.seek; other.serializeAttachment(t); }
      }
      tag.seek = { tc: msg.tc, rated, since: Date.now(), rating };
      ws.serializeAttachment(tag);
      send(ws, { t: 'seeking', tc: msg.tc, rated });
      await this.match();
    } else if (msg.t === 'friend' && isTimeControl(msg.tc)) {
      const side: Side = msg.side === 'w' || msg.side === 'b' ? msg.side : Math.random() < 0.5 ? 'w' : 'b';
      const id = newId();
      const me: Seat = { pid: tag.pid, info: { name: tag.name, account: tag.account } };
      await game(this.env, id).init({ id, tc: msg.tc, rated: false, seats: side === 'w' ? { w: me, b: null } : { w: null, b: me } });
      send(ws, { t: 'created', id });
    }
    this.counts();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.serializeAttachment({});
    this.counts();
  }

  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws); }

  async alarm(): Promise<void> { await this.match(); }

  /** Pair waiting players: same time control, same rated-ness, close enough in rating. */
  private async match(): Promise<void> {
    const now = Date.now();
    const seekers = this.ctx.getWebSockets()
      .map((ws) => ({ ws, tag: ws.deserializeAttachment() as LobbyTag }))
      .filter((s): s is { ws: WebSocket; tag: LobbyTag & { seek: Seek } } => Boolean(s.tag.seek))
      .sort((a, b) => a.tag.seek.since - b.tag.seek.since);
    const taken = new Set<WebSocket>();
    for (const a of seekers) {
      if (taken.has(a.ws)) continue;
      const fits = seekers.filter((b) => b.ws !== a.ws && !taken.has(b.ws) && b.tag.pid !== a.tag.pid &&
        b.tag.seek.tc === a.tag.seek.tc && b.tag.seek.rated === a.tag.seek.rated &&
        (!a.tag.seek.rated || Math.abs(a.tag.seek.rating - b.tag.seek.rating) <=
          Math.min(spread(now - a.tag.seek.since), spread(now - b.tag.seek.since))));
      const b = fits.sort((x, y) => Math.abs(x.tag.seek.rating - a.tag.seek.rating) - Math.abs(y.tag.seek.rating - a.tag.seek.rating))[0];
      if (!b) continue;
      taken.add(a.ws).add(b.ws);
      const { tc, rated } = a.tag.seek;
      const cat = categoryOf(tc);
      const seat = async (t: LobbyTag): Promise<Seat> => ({
        pid: t.pid,
        info: { name: t.name, account: t.account, rating: rated ? await this.ratingOf(t.pid, cat) : undefined },
      });
      const [sa, sb] = [await seat(a.tag), await seat(b.tag)];
      const id = newId();
      await game(this.env, id).init({ id, tc, rated, seats: Math.random() < 0.5 ? { w: sa, b: sb } : { w: sb, b: sa } });
      for (const s of [a, b]) {
        delete (s.tag as LobbyTag).seek;
        s.ws.serializeAttachment(s.tag);
        send(s.ws, { t: 'matched', id });
      }
    }
    const waiting = seekers.length - taken.size;
    if (waiting > 0 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + MATCH_EVERY_MS);
    if (taken.size) this.counts();
  }

  private counts(): void {
    const sockets = this.ctx.getWebSockets();
    const seeking: Partial<Record<TimeControl, number>> = {};
    const online = new Set<string>();
    for (const ws of sockets) {
      const t = ws.deserializeAttachment() as LobbyTag | null;
      if (!t?.pid) continue;
      online.add(t.pid);
      if (t.seek) seeking[t.seek.tc] = (seeking[t.seek.tc] ?? 0) + 1;
    }
    for (const ws of sockets) send(ws, { t: 'counts', seeking, online: online.size });
  }
}

// ---------------------------------------------------------------- game

interface GameTag { pid: string; side: Side | null }

export class Game extends DurableObject<Env> {
  private m: Match | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    void ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get<MatchState>('match');
      if (s) this.m = new Match(s);
    });
  }

  /** Set up a new game; false if this id is already in use. */
  async init(o: { id: string; tc: TimeControl; rated: boolean; seats: Record<Side, Seat | null> }): Promise<boolean> {
    if (this.m) return false;
    this.m = Match.create(o, Date.now());
    await this.save();
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const who = whoOf(request);
    const [client, server] = upgrade();
    const m = this.m;
    if (!m) {
      server.accept();
      send(server, { t: 'error', message: 'No such game. It may have ended a while ago.' });
      server.close(4404, 'no such game');
      return new Response(null, { status: 101, webSocket: client });
    }
    const now = Date.now();
    const side = m.join(who.pid, { name: who.name, account: who.account }, now);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: who.pid, side } satisfies GameTag);
    if (side) m.setGone(side, false, now);
    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const m = this.m;
    const msg = parse<GameClientMsg>(data);
    if (!m || !msg) return;
    const { pid } = ws.deserializeAttachment() as GameTag;
    const now = Date.now();
    let error: string | null = null;
    switch (msg.t) {
      case 'move': error = m.move(pid, String(msg.uci), Number(msg.ply), now); break;
      case 'resign': error = m.resign(pid, now); break;
      case 'abort': error = m.abortBy(pid, now); break;
      case 'draw': error = m.draw(pid, now); break;
      case 'decline': m.decline(pid); break;
      case 'claim': error = m.claim(pid, now); break;
      case 'rematch': if (m.rematch(pid)) await this.rematch(); break;
      default: return;
    }
    if (error) send(ws, { t: 'error', message: error });
    await this.settle();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const m = this.m;
    const tag = ws.deserializeAttachment() as GameTag | null;
    if (!m || !tag?.side) return;
    const still = this.ctx.getWebSockets().some((o) => o !== ws && (o.deserializeAttachment() as GameTag | null)?.side === tag.side);
    if (still) return;
    m.setGone(tag.side, true, Date.now());
    await this.save();
    this.broadcast();
  }

  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws); }

  async alarm(): Promise<void> {
    const m = this.m;
    if (!m) return;
    const now = Date.now();
    if (m.s.status !== 'playing' && now >= m.deadline()) {
      // Long over (or never joined): free the storage.
      for (const ws of this.ctx.getWebSockets()) try { ws.close(1000, 'game expired'); } catch { /* gone */ }
      this.m = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    m.tick(now);
    await this.settle();
  }

  /** After any change: rate a finished game, store, tell everyone, wake for the next deadline. */
  private async settle(): Promise<void> {
    const m = this.m!;
    if (m.ratable && !m.s.result!.change) {
      const r = m.s.result!;
      const score = r.winner === 'w' ? 1 : r.winner === 'b' ? 0 : 0.5;
      const change = await lobby(this.env).rate(m.s.id, categoryOf(m.s.tc), m.s.seats.w!, m.s.seats.b!, score);
      if (change) r.change = change;
    }
    await this.save();
    this.broadcast();
  }

  private async rematch(): Promise<void> {
    const m = this.m!;
    const id = newId();
    const cat = categoryOf(m.s.tc);
    const swap = async (s: Seat): Promise<Seat> => ({
      pid: s.pid,
      info: { ...s.info, rating: m.s.rated ? await lobby(this.env).ratingOf(s.pid, cat) : undefined },
    });
    const w = await swap(m.s.seats.b!), b = await swap(m.s.seats.w!);
    await game(this.env, id).init({ id, tc: m.s.tc, rated: m.s.rated, seats: { w, b } });
    m.s.rematchId = id;
    m.s.rematchOffer = null;
  }

  private async save(): Promise<void> {
    const m = this.m;
    if (!m) return;
    await this.ctx.storage.put('match', m.s);
    await this.ctx.storage.setAlarm(m.deadline());
  }

  private broadcast(): void {
    const m = this.m;
    if (!m) return;
    const game = m.view(Date.now());
    for (const ws of this.ctx.getWebSockets()) {
      const tag = ws.deserializeAttachment() as GameTag | null;
      send(ws, { t: 'game', game, you: tag?.side ?? null });
    }
  }
}

