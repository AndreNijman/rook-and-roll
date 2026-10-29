// Drives the relay under `npm run relay:dev` (or RELAY=ws://host/ws) with
// fake players: quick match, a rated game between two accounts, a friend
// link with a spectator, and a rematch. Accounts are faked with the headers
// games-guard would set, which only work because the relay has no route.

import WebSocket from 'ws';
import type { GameServerMsg, GameView, LobbyServerMsg, Side } from '../src/shared/online';

const RELAY = process.env.RELAY || 'ws://localhost:8797/ws';
const rnd = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

class Client<M extends { t: string }> {
  ws: WebSocket;
  inbox: M[] = [];
  private waiters: (() => void)[] = [];
  constructor(query: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`${RELAY}?${query}`, { headers });
    this.ws.on('message', (d) => { if (process.env.DEBUG) console.log(query.slice(0, 14), String(d).slice(0, 150)); this.inbox.push(JSON.parse(String(d))); for (const w of this.waiters.splice(0)) w(); });
  }
  open() { return new Promise<void>((ok, err) => { this.ws.once('open', () => ok()); this.ws.once('error', err); }); }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  async next<T extends M['t']>(t: T, test: (m: Extract<M, { t: T }>) => boolean = () => true, ms = 5000): Promise<Extract<M, { t: T }>> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === t && test(m as Extract<M, { t: T }>));
      if (i >= 0) return this.inbox.splice(0, i + 1)[i] as Extract<M, { t: T }>;
      if (Date.now() > end) throw new Error(`timed out waiting for ${t}; inbox: ${JSON.stringify(this.inbox.slice(-3))}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 200); });
    }
  }
  close() { this.ws.close(); }
}

type Lobby = Client<LobbyServerMsg>;
type Game = Client<GameServerMsg>;

function player(account?: string): { q: string; headers: Record<string, string> } {
  return account
    ? { q: '', headers: { 'X-Chess-Account': account, 'X-Chess-Name': account } }
    : { q: `&guest=${rnd()}`, headers: {} };
}

async function lobbyFor(p: ReturnType<typeof player>): Promise<Lobby> {
  const c: Lobby = new Client(`lobby=1${p.q}`, p.headers);
  await c.open();
  await c.next('hello');
  return c;
}

async function join(id: string, p: ReturnType<typeof player>): Promise<{ c: Game; you: Side | null; game: GameView }> {
  const c: Game = new Client(`game=${id}${p.q}`, p.headers);
  await c.open();
  const m = await c.next('game');
  return { c, you: m.you, game: m.game };
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
}

async function quickMatch(a: ReturnType<typeof player>, b: ReturnType<typeof player>, rated: boolean) {
  const la = await lobbyFor(a), lb = await lobbyFor(b);
  const tc = rated ? '3+2' : '1+0';
  la.send({ t: 'seek', tc, rated });
  await la.next('seeking');
  lb.send({ t: 'seek', tc, rated });
  const [ma, mb] = await Promise.all([la.next('matched'), lb.next('matched')]);
  check(ma.id === mb.id, `${rated ? 'rated' : 'casual'} quick match pairs both seekers`);
  la.close(); lb.close();
  const ga = await join(ma.id, a), gb = await join(ma.id, b);
  check(ga.you && gb.you && ga.you !== gb.you, 'each player gets a side');
  const w = ga.you === 'w' ? ga : gb, bl = ga.you === 'w' ? gb : ga;
  return { id: ma.id, w, b: bl };
}

const all = (g: { c: Game }[], t: (v: GameView) => boolean) => Promise.all(g.map((x) => x.c.next('game', (m) => t(m.game))));

// 1. Two guests, casual 1+0, fool's mate.
{
  const { w, b } = await quickMatch(player(), player(), false);
  const fools = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  let last: GameServerMsg & { t: 'game' } | undefined;
  for (const [i, uci] of fools.entries()) {
    (i % 2 ? b : w).c.send({ t: 'move', uci, ply: i });
    [last] = await all([w, b], (v) => v.moves.length === i + 1);
  }
  const end = last!;
  check(end.game.result?.winner === 'b' && end.game.result.reason === 'checkmate', 'checkmate ends the game for Black');
  check(!end.game.result?.change, 'a casual game changes no rating');
  w.c.send({ t: 'move', uci: 'e2e4', ply: 4 });
  check((await w.c.next('error')).message, 'moves after the end are refused');
  w.c.close(); b.c.close();
}

// 2. Two accounts, rated 3+2: Black resigns; then a rematch swaps colours.
{
  const a = player(`acct-${rnd().slice(0, 6)}`), bb = player(`acct-${rnd().slice(0, 6)}`);
  const { w, b } = await quickMatch(a, bb, true);
  check(w.game.rated && w.game.players.w?.rating?.rating === 1500, 'rated game shows both ratings');
  w.c.send({ t: 'move', uci: 'e2e4', ply: 0 }); await all([w, b], (v) => v.moves.length === 1);
  b.c.send({ t: 'move', uci: 'e7e5', ply: 1 }); await all([w, b], (v) => v.moves.length === 2 && v.running);
  b.c.send({ t: 'resign' });
  const [end] = await all([w, b], (v) => Boolean(v.result?.change));
  const ch = end.game.result!.change!;
  check(end.game.result?.winner === 'w' && ch.w!.after > 1500 && ch.b!.after < 1500, `ratings move: W ${ch.w!.after}, B ${ch.b!.after}`);
  w.c.send({ t: 'rematch' }); await all([w, b], (v) => v.rematchOffer !== null);
  b.c.send({ t: 'rematch' });
  const [re] = await all([w, b], (v) => Boolean(v.rematchId));
  const next = await join(re.game.rematchId!, a.headers['X-Chess-Account'] === w.game.players.w?.name ? a : bb);
  check(next.you === 'b' && next.game.players.w?.rating?.rating === ch.b!.after, 'rematch swaps colours and carries new ratings');
  const la = await lobbyFor(a);
  la.close();
  w.c.close(); b.c.close(); next.c.close();
}

// 3. A friend link: creator, friend, then a spectator; a draw by agreement.
{
  const me = player(), friend = player(), watcher = player();
  const l = await lobbyFor(me);
  l.send({ t: 'friend', tc: '10+5', side: 'b' });
  const { id } = await l.next('created');
  l.close();
  const host = await join(id, me);
  check(host.you === 'b' && host.game.status === 'waiting', 'friend game waits with the creator as Black');
  const guest = await join(id, friend);
  check(guest.you === 'w' && guest.game.status === 'playing' && !guest.game.rated, 'friend takes the open seat, unrated');
  const spec = await join(id, watcher);
  check(spec.you === null, 'a third visitor watches');
  guest.c.send({ t: 'move', uci: 'd2d4', ply: 0 }); await all([host, spec], (v) => v.moves.length === 1);
  host.c.send({ t: 'move', uci: 'd7d5', ply: 1 }); await all([guest, spec], (v) => v.moves.length === 2);
  spec.c.send({ t: 'move', uci: 'c2c4', ply: 2 });
  check((await spec.c.next('error')).message.includes('watching'), 'spectators cannot move');
  guest.c.send({ t: 'draw' }); await host.c.next('game', (m) => m.game.drawOffer === 'w');
  host.c.send({ t: 'draw' });
  const end = await spec.c.next('game', (m) => m.game.status === 'over');
  check(end.game.result?.reason === 'agreement', 'draw by agreement');
  host.c.close(); guest.c.close(); spec.c.close();
}

// 4. An unknown game id.
{
  const c: Game = new Client(`game=zzzzzzzz${player().q}`);
  await c.open();
  check((await c.next('error')).message.startsWith('No such game'), 'unknown game says so');
  c.close();
}

// 5. Nobody moves: the Durable Object's alarm aborts the game after FIRST_MOVE_MS.
if (!process.env.QUICK) {
  const { w, b } = await quickMatch(player(), player(), false);
  const end = await w.c.next('game', (m) => m.game.status === 'over', 40_000);
  check(end.game.result?.reason === 'aborted', 'no first move: the alarm aborts the game');
  w.c.close(); b.c.close();
}

console.log('online smoke passed');
process.exit(0);
