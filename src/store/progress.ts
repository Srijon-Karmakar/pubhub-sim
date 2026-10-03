import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { City, Mode, RunResult } from '../types';

interface Best {
  score: number;
  stars: number;
  date: number;
}

/** Enough to reopen the last shift from the home screen in one tap. */
export interface LastShift {
  city: City;
  lineKey: string;
  variantId: number;
  startIdx: number;
  endIdx: number;
  lineRef: string;
  lineName: string;
  colour: string;
  textColour: string;
  mode: Mode;
  from: string;
  to: string;
  date: number;
}

interface Totals {
  runs: number;
  distance: number;
  pax: number;
  perfect: number;
  stars: number;
  time: number;
  xp: number;
}

interface Progress {
  runs: RunResult[];
  best: Record<string, Best>;
  totals: Totals;
  recentCities: City[];
  lastShift: LastShift | null;
  addRun: (r: RunResult) => boolean;
  addRecentCity: (c: City) => void;
  setLastShift: (s: LastShift) => void;
  reset: () => void;
}

const emptyTotals: Totals = { runs: 0, distance: 0, pax: 0, perfect: 0, stars: 0, time: 0, xp: 0 };

export const useProgress = create<Progress>()(
  persist(
    (set, get) => ({
      runs: [],
      best: {},
      totals: emptyTotals,
      recentCities: [],
      lastShift: null,
      addRun: (r) => {
        const prev = get().best[r.routeKey];
        const isBest = !prev || r.score > prev.score;
        set((s) => ({
          runs: [r, ...s.runs].slice(0, 40),
          best: isBest ? { ...s.best, [r.routeKey]: { score: r.score, stars: Math.max(r.stars, prev?.stars ?? 0), date: r.date } } : s.best,
          totals: {
            runs: s.totals.runs + 1,
            distance: s.totals.distance + r.distance,
            pax: s.totals.pax + r.paxDelivered,
            perfect: s.totals.perfect + r.perfect,
            stars: s.totals.stars + Math.max(0, r.stars - (prev?.stars ?? 0)),
            time: s.totals.time + r.duration,
            xp: (s.totals.xp ?? 0) + r.score,
          },
        }));
        return isBest;
      },
      addRecentCity: (c) =>
        set((s) => ({ recentCities: [c, ...s.recentCities.filter((x) => x.id !== c.id && x.name !== c.name)].slice(0, 6) })),
      setLastShift: (lastShift) => set({ lastShift }),
      reset: () => set({ runs: [], best: {}, totals: emptyTotals, lastShift: null }),
    }),
    {
      name: 'publicport-progress',
      version: 2,
      migrate: (state, version) => {
        const s = state as Progress;
        if (version < 2) {
          s.totals = { ...emptyTotals, ...s.totals, xp: (s.runs ?? []).reduce((a, r) => a + r.score, 0) };
          s.lastShift = null;
        }
        return s;
      },
    },
  ),
);
