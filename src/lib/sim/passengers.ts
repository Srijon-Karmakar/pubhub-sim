import type { Stop } from '../../types';
import type { VehicleProfile } from './profiles';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const HUB = /central|centre|center|station|junction|terminal|terminus|hbf|hauptbahnhof|bahnhof|gare|main|square|plaza|interchange|airport|university|market|park|city|downtown|cbd/i;

function hourFactor(h: number): number {
  if (h >= 7 && h < 10) return 1.75;
  if (h >= 16.5 && h < 19.5) return 1.65;
  if (h >= 10 && h < 16.5) return 1.0;
  if (h >= 19.5 && h < 22.5) return 0.65;
  if (h >= 5.5 && h < 7) return 0.7;
  return 0.25;
}

export interface PaxPlan {
  waiting: number[];
  alightFrac: number[];
}

export function planPassengers(stops: Stop[], p: VehicleProfile, hourLocal: number, seed: number): PaxPlan {
  const rnd = mulberry32(seed);
  const hf = hourFactor(hourLocal);
  const waiting = stops.map((s, i) => {
    if (i === stops.length - 1) return 0;
    let imp = 0.45 + rnd() * 1.3;
    if (HUB.test(s.name)) imp *= 1.9;
    if (i === 0) imp *= 1.4;
    return Math.max(1, Math.round(p.baseWaiting * hf * imp));
  });
  const alightFrac = stops.map((_, i) => (i === 0 ? 0 : i === stops.length - 1 ? 1 : 0.08 + rnd() * 0.32));
  return { waiting, alightFrac };
}
