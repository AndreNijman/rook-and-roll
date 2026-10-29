// Small synthesised sounds: a wooden tock for a move, a sharper knock for a
// capture, a two-note ping for check and a little tune when the game ends.
// No files to load, and nothing plays until the player has touched the page.

export type Sound = 'move' | 'capture' | 'check' | 'castle' | 'win' | 'lose' | 'draw' | 'wrong' | 'right';

let ctx: AudioContext | null = null;
let muted = false;
try { muted = localStorage.getItem('rookroll:muted') === '1'; } catch { /* storage blocked */ }

export const isMuted = () => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem('rookroll:muted', m ? '1' : '0'); } catch { /* storage blocked */ }
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

function tone(a: AudioContext, freq: number, at: number, len: number, type: OscillatorType, vol: number, drop = 0.5): void {
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + at);
  o.frequency.exponentialRampToValueAtTime(freq * drop, a.currentTime + at + len);
  g.gain.setValueAtTime(vol, a.currentTime + at);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + at + len);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + at);
  o.stop(a.currentTime + at + len + 0.02);
}

export function play(s: Sound): void {
  const a = audio();
  if (!a) return;
  switch (s) {
    case 'move': tone(a, 420, 0, 0.07, 'triangle', 0.35, 0.4); break;
    case 'castle': tone(a, 420, 0, 0.06, 'triangle', 0.3, 0.4); tone(a, 380, 0.08, 0.06, 'triangle', 0.3, 0.4); break;
    case 'capture': tone(a, 260, 0, 0.1, 'square', 0.18, 0.3); tone(a, 620, 0, 0.04, 'triangle', 0.25, 0.5); break;
    case 'check': tone(a, 880, 0, 0.08, 'square', 0.12, 1); tone(a, 1175, 0.09, 0.12, 'square', 0.12, 1); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(a, f, i * 0.1, 0.16, 'square', 0.1, 1)); break;
    case 'lose': [392, 330, 262].forEach((f, i) => tone(a, f, i * 0.14, 0.2, 'triangle', 0.25, 0.9)); break;
    case 'draw': [440, 440].forEach((f, i) => tone(a, f, i * 0.14, 0.14, 'triangle', 0.25, 1)); break;
    case 'right': tone(a, 784, 0, 0.1, 'square', 0.1, 1); tone(a, 1047, 0.1, 0.16, 'square', 0.1, 1); break;
    case 'wrong': tone(a, 200, 0, 0.22, 'sawtooth', 0.1, 0.7); break;
  }
}
