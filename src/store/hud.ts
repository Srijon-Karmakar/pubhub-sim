import { create } from 'zustand';
import type { HudSnapshot, Tone } from '../lib/sim/engine';

export interface ToastItem {
  id: number;
  kind: 'score' | 'toast';
  label: string;
  sub?: string;
  points?: number;
  tone: Tone;
}

interface HudState {
  snap: HudSnapshot | null;
  paused: boolean;
  warp: 1 | 2 | 4;
  freeCam: boolean;
  toasts: ToastItem[];
  utcOffset: number;
  stopTargets: number[];
  /** cinematic title card at the start of a shift */
  intro: boolean;
}

export const useHud = create<HudState>()(() => ({
  snap: null,
  paused: false,
  warp: 1,
  freeCam: false,
  toasts: [],
  utcOffset: 0,
  stopTargets: [],
  intro: false,
}));

let tid = 1;
export function pushToast(t: Omit<ToastItem, 'id'>) {
  const id = tid++;
  const ttl = t.kind === 'score' ? 2300 : 2800;
  useHud.setState((s) => {
    // de-duplicate identical toasts
    if (t.kind === 'toast' && s.toasts.some((x) => x.label === t.label)) return s;
    return { toasts: [...s.toasts.slice(-3), { ...t, id }] };
  });
  setTimeout(() => useHud.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), ttl);
}
