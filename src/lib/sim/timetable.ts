import type { Stop } from '../../types';
import type { VehicleProfile } from './profiles';
import { vehicleLength } from './profiles';
import type { Track } from './track';

export interface Timetable {
  stops: Stop[];
  /** front-of-vehicle stopping point for each stop */
  targets: number[];
  arr: number[];
  dep: number[];
  /** ideal cumulative run-time grid (padded), for live ETA */
  gridS0: number;
  gridDs: number;
  gridT: Float64Array;
}

export function stopTarget(track: Track, p: VehicleProfile, stop: Stop, isLast: boolean, mode: string): number {
  const L = vehicleLength(p);
  let t: number;
  if (mode === 'bus' || mode === 'trolleybus') t = stop.s + 4;
  else if (mode === 'ferry') t = stop.s + L * 0.25;
  else t = stop.s + L / 2;
  if (isLast) t = Math.min(t, track.length - 3);
  return t;
}

const resist = (v: number) => 0.012 + 0.00018 * v * v;

export function buildTimetable(
  track: Track,
  p: VehicleProfile,
  allStops: Stop[],
  startIdx: number,
  endIdx: number,
  mode: string,
  firstDwell: number,
): Timetable {
  const stops = allStops.slice(startIdx, endIdx + 1);
  const targets = stops.map((s, i) => stopTarget(track, p, s, i === stops.length - 1 && endIdx === allStops.length - 1, mode));
  for (let i = 1; i < targets.length; i++) targets[i] = Math.max(targets[i], targets[i - 1] + 20);

  const ds = 5;
  const s0 = targets[0];
  const sN = targets[targets.length - 1];
  const N = Math.max(2, Math.ceil((sN - s0) / ds) + 1);
  const cap = new Float64Array(N);
  for (let i = 0; i < N; i++) cap[i] = track.limitAt(s0 + i * ds) * 0.93;
  for (const t of targets) cap[Math.min(N - 1, Math.max(0, Math.round((t - s0) / ds)))] = 0;
  cap[0] = 0;
  cap[N - 1] = 0;

  const v = new Float64Array(N);
  for (let i = 0; i < N - 1; i++) {
    const a = 0.8 * p.accel * Math.min(1, p.vBase / Math.max(v[i], 0.5)) - resist(v[i]);
    v[i + 1] = Math.min(cap[i + 1], Math.sqrt(Math.max(0, v[i] * v[i] + 2 * Math.max(0.05, a) * ds)));
  }
  const b = 0.62 * p.brake;
  for (let i = N - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * b * ds));

  const pad = 1.08;
  const gridT = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    const vs = Math.max(0.35, v[i - 1] + v[i]);
    gridT[i] = gridT[i - 1] + ((2 * ds) / vs) * pad;
  }
  const tAt = (s: number) => gridT[Math.min(N - 1, Math.max(0, Math.round((s - s0) / ds)))];

  const arr: number[] = [0];
  const dep: number[] = [firstDwell];
  for (let k = 1; k < targets.length; k++) {
    const run = tAt(targets[k]) - tAt(targets[k - 1]) + 4;
    arr[k] = Math.round(dep[k - 1] + run);
    dep[k] = k === targets.length - 1 ? arr[k] : Math.round(arr[k] + p.dwell);
  }
  return { stops, targets, arr, dep, gridS0: s0, gridDs: ds, gridT };
}

export function idealTimeBetween(tt: Timetable, a: number, b: number): number {
  const N = tt.gridT.length;
  const ia = Math.min(N - 1, Math.max(0, Math.round((a - tt.gridS0) / tt.gridDs)));
  const ib = Math.min(N - 1, Math.max(0, Math.round((b - tt.gridS0) / tt.gridDs)));
  return Math.max(0, tt.gridT[ib] - tt.gridT[ia]);
}
