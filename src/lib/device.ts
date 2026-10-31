/**
 * Coarse device class, decided once. Phones and small-memory devices get cheaper rendering:
 * lower pixel ratio, no antialiasing, fewer NPCs, no decorative texture layers, no backdrop blur.
 */
const nav = (typeof navigator === 'undefined' ? {} : navigator) as Navigator & { deviceMemory?: number };

function detect(): { low: boolean; veryLow: boolean } {
  try {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const small = Math.min(window.screen.width, window.screen.height) < 700;
    const cores = nav.hardwareConcurrency ?? 8;
    const mem = nav.deviceMemory ?? 8;
    return { low: (coarse && small) || mem <= 4 || cores <= 2, veryLow: mem <= 2 || cores <= 2 };
  } catch {
    return { low: false, veryLow: false };
  }
}

const d = detect();

export const LOW_END = d.low;
export const VERY_LOW_END = d.veryLow;

/** device pixel ratio cap for the WebGL map */
export const MAP_DPR_CAP = LOW_END ? 1.5 : 2;
