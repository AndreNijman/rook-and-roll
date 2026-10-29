// Who is playing, and the profile that follows them. Guests keep everything
// in this browser; a games account also keeps a copy on the guard
// (/_guard/profile, keyed by the "chess" host), so puzzle ratings and bot
// records come along to another device. The newer copy wins.

export interface BotRecord { w: number; l: number; d: number }

export interface Profile {
  v: 1;
  updatedAt: number;
  theme: string;
  puzzle: { rating: number; rd: number; vol: number; solved: number; failed: number; recent: string[] };
  bots: Record<string, BotRecord>;
}

export interface Status { signedIn: boolean; username: string | null }

const KEY = 'rookroll:profile';
const fresh = (): Profile => ({
  v: 1, updatedAt: 0, theme: 'Walnut',
  puzzle: { rating: 1500, rd: 350, vol: 0.06, solved: 0, failed: 0, recent: [] },
  bots: {},
});

let status: Status = { signedIn: false, username: null };
let profile: Profile = load();
let pushTimer = 0;

function load(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p?.v === 1) return { ...fresh(), ...p, puzzle: { ...fresh().puzzle, ...p.puzzle } };
  } catch { /* storage blocked or corrupt */ }
  return fresh();
}

export const me = () => status;
export const getProfile = () => profile;

export function loginUrl(): string {
  return `https://games.andrenijman.com/_guard/login?return=${encodeURIComponent(location.origin + '/')}`;
}

export function saveProfile(change: (p: Profile) => void): void {
  change(profile);
  profile.updatedAt = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* storage blocked */ }
  if (status.signedIn) {
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => {
      void fetch('/_guard/profile', { method: 'PUT', credentials: 'same-origin', body: JSON.stringify(profile) }).catch(() => {});
    }, 1200);
  }
}

/**
 * Read the guard's status and, for an account, pull the stored profile.
 * True when that replaced the profile the page started with.
 */
export async function connect(): Promise<boolean> {
  try {
    const res = await fetch('/_guard/status', { cache: 'no-store', credentials: 'same-origin' });
    const s = res.ok ? await res.json() : null;
    status = { signedIn: Boolean(s?.signedIn && s.username), username: s?.username ?? null };
  } catch {
    // No guard (local dev, or GitHub Pages directly): play as a guest.
  }
  if (!status.signedIn) return false;
  try {
    const res = await fetch('/_guard/profile', { cache: 'no-store', credentials: 'same-origin' });
    const remote = res.ok ? (await res.json()).profile : null;
    if (remote?.v === 1 && remote.updatedAt > profile.updatedAt) {
      profile = { ...fresh(), ...remote, puzzle: { ...fresh().puzzle, ...remote.puzzle } };
      try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* storage blocked */ }
      return true;
    } else if (profile.updatedAt > (remote?.updatedAt ?? 0)) {
      saveProfile(() => {});
    }
  } catch { /* keep the local copy */ }
  return false;
}
