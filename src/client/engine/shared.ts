// One engine for the whole app: Stockfish is ~7 MB of memory per instance,
// and only one thing at a time needs it.

import { Engine } from './engine';

let instance: Engine | null = null;
export const engine = () => (instance ??= new Engine());

/** Full strength, for hints, analysis and review. */
export const FULL = { UCI_LimitStrength: false, 'Skill Level': 20 };
