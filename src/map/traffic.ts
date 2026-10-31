import { hexToGl } from '../lib/color';
import { EARTH_R } from '../lib/geo';
import { hashString, mulberry32 } from '../lib/sim/passengers';
import type { WeatherKind } from '../types';
import type { C4, MeshBuilder, V2 } from './mesh';

/**
 * Ambient city life around the player's route, driven by the roads and rails the base map has already loaded:
 * cars, taxis, buses, auto-rickshaws, motorbikes, cyclists, pedestrians and neighbouring trains.
 *
 * Behaviour: vehicles follow their lane, keep a gap to the one ahead, stop at traffic lights and at level
 * crossings when a train is coming (unless they're one of the impatient few who ignore both), slow and switch
 * headlights on in rain, fog or darkness; pedestrians thin out in rain, heat and at night and open umbrellas.
 */

const RAD = Math.PI / 180;

export interface RoadFeature {
  cls: string;
  oneway: number;
  coords: [number, number][];
}

export interface TrafficCtx {
  lat: number;
  lon: number;
  /** distance of the player's front along the route */
  s: number;
  trainLength: number;
  rail: boolean;
  pointAt: (s: number) => [number, number];
  roads: () => RoadFeature[];
  rails: () => RoadFeature[];
  weather: WeatherKind;
  temp: number;
  night: number;
  driveSide: -1 | 1;
  paused: boolean;
  groundZ: number;
  /** 1 on desktop, lower on phones */
  density: number;
}

interface Way {
  id: string;
  pts: V2[];
  cum: number[];
  len: number;
  cls: string;
  half: number;
  limit: number;
  oneway: number;
  rail: boolean;
  juncs: Arm[];
  cross: Crossing[];
  dead: boolean;
  bbox: [number, number, number, number];
}

interface Junction {
  x: number;
  y: number;
  arms: Arm[];
  signal: boolean;
  off: number;
}

interface Arm {
  way: Way;
  s: number;
  j: Junction;
  group: number;
}

interface Crossing {
  x: number;
  y: number;
  way: Way;
  s: number;
  routeS: number;
  closed: number;
}

type Kind = 'car' | 'taxi' | 'bus' | 'auto' | 'bike' | 'cycle' | 'ped' | 'train';

interface Agent {
  kind: Kind;
  way: Way;
  s: number;
  dir: 1 | -1;
  v: number;
  v0: number;
  lat: number;
  x: number;
  y: number;
  hx: number;
  hy: number;
  len: number;
  half: number;
  obeys: boolean;
  brake: boolean;
  color: C4;
  accent: C4;
  skin: C4;
  umbrella: C4 | null;
  cars: number;
  pause: number;
  dead: boolean;
  seed: number;
}

const c = (h: string, a = 1) => hexToGl(h, a);
const CAR_COLOURS = ['#c9cdd3', '#2b2f36', '#9b1c1c', '#1d4e89', '#e8eaee', '#3f6b4f', '#8a6b3b', '#6b7280', '#5b3a29'].map((h) => c(h));
const BUS_COLOURS = ['#c0392b', '#1f5fa8', '#2e7d4f', '#e0a31a'].map((h) => c(h));
const SHIRT = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1', '#e67e22', '#1abc9c', '#d35400', '#c0392b', '#ff7eb6', '#111827'].map((h) => c(h));
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0522d'].map((h) => c(h));
const UMBRELLA = ['#111827', '#b91c1c', '#1d4ed8', '#047857', '#7c3aed', '#f59e0b'].map((h) => c(h));

const K = {
  glass: c('#16212c'),
  tyre: c('#15171a'),
  head: c('#fff4cf'),
  headOff: c('#d8d2bc'),
  tail: c('#ff2d2d'),
  tailOff: c('#6e1414'),
  taxi: c('#f2b705'),
  taxiRoof: c('#16181b'),
  autoBody: c('#e6bd1e'),
  autoRoof: c('#1c7a3a'),
  black: c('#101214'),
  white: c('#f2f3f5'),
  red: c('#ff3030'),
  amber: c('#ffb020'),
  green: c('#35e07a'),
  lampOff: c('#2a2d31'),
  pole: c('#3b4048'),
  train: c('#e4e7ea'),
  trainBand: c('#1f5fa8'),
  barrier: c('#f4f4f4'),
  barrierRed: c('#d62828'),
  bumper: c('#2a2d33'),
  chrome: c('#c9ced6'),
  grille: c('#17191d'),
  plate: c('#f1ecd0'),
  stripe: c('#f4f5f7'),
  hub: c('#9aa1ab'),
  mirror: c('#1c1e22'),
  shadow: [0, 0, 0, 0.3] as C4,
  door: c('#18408a'),
  roofUnit: c('#aeb4bc'),
};
const HAIR = ['#15110e', '#2a1d14', '#3b2a1c', '#6b6b6b', '#0c0c0c'].map((h) => c(h));
const PANTS = ['#2b3445', '#3a3f4a', '#5a4632', '#1f2937', '#6b7280', '#44403c'].map((h) => c(h));

/** slightly darker or lighter copy of a colour: panel shading, skirts, per-vehicle paint variation */
const tone = (col: C4, k: number): C4 => [Math.min(1, col[0] * k), Math.min(1, col[1] * k), Math.min(1, col[2] * k), col[3]];

const CLASS: Record<string, { half: number; limit: number }> = {
  motorway: { half: 7, limit: 22 },
  trunk: { half: 6, limit: 17 },
  primary: { half: 5, limit: 14 },
  secondary: { half: 5, limit: 13 },
  tertiary: { half: 4, limit: 11 },
  minor: { half: 3.4, limit: 9 },
  service: { half: 2.4, limit: 5 },
};

const WEATHER_SPEED: Record<WeatherKind, number> = { clear: 1, cloudy: 1, fog: 0.72, rain: 0.78, storm: 0.58, snow: 0.55 };

function segInter(a: V2, b: V2, c1: V2, d: V2): [number, number, number] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c1[0];
  const sy = d[1] - c1[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c1[0] - a[0];
  const qy = c1[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + rx * t, a[1] + ry * t, t];
}

function signalState(j: Junction, group: number, t: number): 'green' | 'amber' | 'red' {
  const T = 44;
  const p = (((t + j.off) % T) + T) % T;
  if (p < 17) return group === 0 ? 'green' : 'red';
  if (p < 20) return group === 0 ? 'amber' : 'red';
  if (p < 22) return 'red';
  if (p < 39) return group === 1 ? 'green' : 'red';
  if (p < 42) return group === 1 ? 'amber' : 'red';
  return 'red';
}

export class Traffic {
  private lat0 = 0;
  private lon0 = 0;
  private kx = 1;
  private ky = RAD * EARTH_R;
  private ways = new Map<string, Way>();
  private juncs: Junction[] = [];
  private crossings: Crossing[] = [];
  private agents: Agent[] = [];
  private clock = 0;
  private gatherT = 99;
  private dirty = false;
  private crossAt = -1e9;
  private rnd = mulberry32(1);
  private nextSeed = 1;
  /** world-space position of the player, kept for spawning */
  private px = 0;
  private py = 0;
  nearMisses = 0;

  reset(seed: string) {
    this.ways.clear();
    this.juncs = [];
    this.crossings = [];
    this.agents = [];
    this.clock = 0;
    this.gatherT = 99;
    this.crossAt = -1e9;
    this.rnd = mulberry32(hashString(seed));
    this.lat0 = 0;
    this.nearMisses = 0;
  }

  private enu(lat: number, lon: number): V2 {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }

  /** world ENU of a lat/lon (the mesh is built relative to the player, in the player's own frame) */
  world(lat: number, lon: number): V2 {
    return this.enu(lat, lon);
  }

  // ------------------------------------------------------------------ roads
  private addWay(f: RoadFeature, rail: boolean) {
    if (f.coords.length < 2) return;
    const pts: V2[] = f.coords.map(([lo, la]) => this.enu(la, lo));
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of pts) {
      bx0 = Math.min(bx0, p[0]);
      bx1 = Math.max(bx1, p[0]);
      by0 = Math.min(by0, p[1]);
      by1 = Math.max(by1, p[1]);
    }
    if (bx0 > this.px + 300 || bx1 < this.px - 300 || by0 > this.py + 300 || by1 < this.py - 300) return;
    const key = `${rail ? 'r' : 'o'}${f.cls}:${Math.round(pts[0][0])}:${Math.round(pts[0][1])}:${Math.round(pts[pts.length - 1][0])}:${Math.round(pts[pts.length - 1][1])}:${pts.length}`;
    if (this.ways.has(key)) return;
    const cum = [0];
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      minx = Math.min(minx, pts[i][0]);
      maxx = Math.max(maxx, pts[i][0]);
      miny = Math.min(miny, pts[i][1]);
      maxy = Math.max(maxy, pts[i][1]);
    }
    const len = cum[cum.length - 1];
    if (len < 8) return;
    const cl = CLASS[f.cls] ?? CLASS.minor;
    this.ways.set(key, { id: key, pts, cum, len, cls: f.cls, half: cl.half, limit: cl.limit, oneway: f.oneway, rail, juncs: [], cross: [], dead: false, bbox: [minx, miny, maxx, maxy] });
    this.dirty = true;
  }

  private sample(w: Way, s: number): [number, number, number, number] {
    const cum = w.cum;
    const t = Math.max(0, Math.min(w.len, s));
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    const a = w.pts[lo];
    const b = w.pts[hi];
    const seg = cum[hi] - cum[lo] || 1;
    const f = (t - cum[lo]) / seg;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, (b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
  }

  private rebuildJunctions() {
    this.dirty = false;
    const all = [...this.ways.values()].filter((w) => !w.dead);
    for (const w of all) w.juncs = [];
    const juncs: Junction[] = [];
    const place = (x: number, y: number, a: Way, sa: number, b: Way, sb: number) => {
      let j = juncs.find((q) => Math.hypot(q.x - x, q.y - y) < 7);
      if (!j) {
        j = { x, y, arms: [], signal: false, off: hashString(`${Math.round(x)}:${Math.round(y)}`) % 44 };
        juncs.push(j);
      }
      for (const [w, s] of [[a, sa], [b, sb]] as [Way, number][]) {
        const ex = j.arms.find((m) => m.way === w);
        if (ex) {
          if (Math.abs(ex.s - s) > 9) j.arms.push({ way: w, s, j, group: 0 });
        } else j.arms.push({ way: w, s, j, group: 0 });
      }
    };
    for (let i = 0; i < all.length; i++) {
      const A = all[i];
      if (A.rail) continue;
      for (let k = i + 1; k < all.length; k++) {
        const B = all[k];
        if (B.rail) continue;
        if (A.bbox[2] < B.bbox[0] || B.bbox[2] < A.bbox[0] || A.bbox[3] < B.bbox[1] || B.bbox[3] < A.bbox[1]) continue;
        for (let m = 0; m + 1 < A.pts.length; m++) {
          for (let n = 0; n + 1 < B.pts.length; n++) {
            const hit = segInter(A.pts[m], A.pts[m + 1], B.pts[n], B.pts[n + 1]);
            if (!hit) continue;
            const sa = A.cum[m] + (A.cum[m + 1] - A.cum[m]) * hit[2];
            const sb = B.cum[n] + Math.hypot(hit[0] - B.pts[n][0], hit[1] - B.pts[n][1]);
            place(hit[0], hit[1], A, sa, B, sb);
          }
        }
        // ends that meet another road without crossing it
        for (const [P, Q] of [[A, B], [B, A]] as [Way, Way][]) {
          for (const end of [0, P.len]) {
            const [ex, ey] = end === 0 ? P.pts[0] : P.pts[P.pts.length - 1];
            for (let n = 0; n + 1 < Q.pts.length; n++) {
              const a = Q.pts[n];
              const b = Q.pts[n + 1];
              const dx = b[0] - a[0];
              const dy = b[1] - a[1];
              const l2 = dx * dx + dy * dy || 1;
              const t = Math.max(0, Math.min(1, ((ex - a[0]) * dx + (ey - a[1]) * dy) / l2));
              const qx = a[0] + dx * t;
              const qy = a[1] + dy * t;
              if (Math.hypot(qx - ex, qy - ey) < 3) {
                place(qx, qy, P, end, Q, Q.cum[n] + Math.hypot(qx - a[0], qy - a[1]));
                break;
              }
            }
          }
        }
      }
    }
    for (const j of juncs) {
      if (j.arms.length < 2) continue;
      const a0 = j.arms[0];
      const [, , ux0, uy0] = this.sample(a0.way, a0.s);
      for (const arm of j.arms) {
        const [, , ux, uy] = this.sample(arm.way, arm.s);
        arm.group = Math.abs(ux * ux0 + uy * uy0) < 0.7 ? 1 : 0;
        arm.way.juncs.push(arm);
      }
      const big = j.arms.some((m) => m.way.cls !== 'service');
      j.signal = big && j.arms.some((m) => m.group === 1) && j.arms.some((m) => m.group === 0) && hashString(`sig${Math.round(j.x)}:${Math.round(j.y)}`) % 100 < 42;
    }
    for (const w of all) w.juncs.sort((p, q) => p.s - q.s);
    this.juncs = juncs;
  }

  private rebuildCrossings(ctx: TrafficCtx) {
    this.crossAt = ctx.s;
    for (const w of this.ways.values()) w.cross = [];
    this.crossings = [];
    if (!ctx.rail) return;
    const route: { p: V2; s: number }[] = [];
    for (let s = Math.max(0, ctx.s - 80); s < ctx.s + 600; s += 5) {
      const [la, lo] = ctx.pointAt(s);
      route.push({ p: this.enu(la, lo), s });
    }
    for (const w of this.ways.values()) {
      if (w.rail || w.dead || w.cls === 'motorway') continue;
      for (let m = 0; m + 1 < w.pts.length; m++) {
        for (let n = 0; n + 1 < route.length; n++) {
          const hit = segInter(w.pts[m], w.pts[m + 1], route[n].p, route[n + 1].p);
          if (!hit) continue;
          const cr: Crossing = { x: hit[0], y: hit[1], way: w, s: w.cum[m] + (w.cum[m + 1] - w.cum[m]) * hit[2], routeS: route[n].s + 5 * (Math.hypot(hit[0] - route[n].p[0], hit[1] - route[n].p[1]) / (Math.hypot(route[n + 1].p[0] - route[n].p[0], route[n + 1].p[1] - route[n].p[1]) || 1)), closed: 0 };
          if (!w.cross.some((q) => Math.abs(q.s - cr.s) < 12)) {
            w.cross.push(cr);
            this.crossings.push(cr);
          }
        }
      }
      w.cross.sort((a, b) => a.s - b.s);
    }
  }

  // ------------------------------------------------------------------ agents
  private spawn(ctx: TrafficCtx, kind: Kind, minD: number, maxD: number): Agent | null {
    const rnd = this.rnd;
    const pool = [...this.ways.values()].filter((w) => !w.dead && (kind === 'train' ? w.rail : !w.rail));
    if (!pool.length) return null;
    for (let tries = 0; tries < 8; tries++) {
      const w = pool[Math.floor(rnd() * pool.length)];
      if (kind === 'bus' && (w.cls === 'service' || w.cls === 'minor')) continue;
      if ((kind === 'cycle' || kind === 'auto') && w.cls === 'motorway') continue;
      if (kind === 'ped' && (w.cls === 'motorway' || w.cls === 'trunk')) continue;
      if (kind === 'train' && w.len < 90) continue;
      const s = rnd() * w.len;
      const [x, y, ux, uy] = this.sample(w, s);
      const d = Math.hypot(x - this.px, y - this.py);
      if (d < minD || d > maxD) continue;
      const dir: 1 | -1 = w.oneway === 1 ? 1 : w.oneway === -1 ? -1 : rnd() < 0.5 ? 1 : -1;
      const reckless = rnd() < 0.14;
      const body = kind === 'taxi' ? K.taxi : kind === 'bus' ? BUS_COLOURS[Math.floor(rnd() * BUS_COLOURS.length)] : kind === 'auto' ? K.autoBody : CAR_COLOURS[Math.floor(rnd() * CAR_COLOURS.length)];
      const wetWeather = ctx.weather === 'rain' || ctx.weather === 'storm';
      const hot = Number.isFinite(ctx.temp) && ctx.temp >= 33 && ctx.night < 0.3;
      const a: Agent = {
        kind,
        way: w,
        s,
        dir,
        v: kind === 'ped' ? 1.2 : Math.min(w.limit, 6),
        v0: 0,
        lat: 0,
        x,
        y,
        hx: ux * dir,
        hy: uy * dir,
        len: 4.2,
        half: 0.88,
        obeys: !reckless,
        brake: false,
        color: body,
        accent: K.autoRoof,
        skin: SKIN[Math.floor(rnd() * SKIN.length)],
        umbrella: kind === 'ped' && ((wetWeather && rnd() < 0.8) || (hot && rnd() < 0.4)) ? UMBRELLA[Math.floor(rnd() * UMBRELLA.length)] : null,
        cars: 3,
        pause: 0,
        dead: false,
        seed: this.nextSeed++,
      };
      switch (kind) {
        case 'taxi':
          a.len = 4.3;
          break;
        case 'bus':
          a.len = 10.8;
          a.half = 1.28;
          break;
        case 'auto':
          a.len = 2.7;
          a.half = 0.68;
          break;
        case 'bike':
          a.len = 1.95;
          a.half = 0.3;
          break;
        case 'cycle':
          a.len = 1.75;
          a.half = 0.25;
          break;
        case 'ped':
          a.len = 0.5;
          a.half = 0.2;
          a.color = SHIRT[Math.floor(rnd() * SHIRT.length)];
          break;
        case 'train':
          a.len = 21;
          a.half = 1.45;
          a.cars = 3 + Math.floor(rnd() * 2);
          a.color = K.train;
          a.s = Math.max(a.cars * 22, Math.min(w.len - 5, s));
          break;
        default:
          break;
      }
      const speedMul = kind === 'bus' ? 0.8 : kind === 'auto' ? 0.7 : kind === 'cycle' ? 0.3 : kind === 'bike' ? 1.1 : 1;
      a.v0 = kind === 'ped' ? 1.0 + rnd() * 0.55 : kind === 'train' ? 9 + rnd() * 7 : w.limit * speedMul * (0.8 + rnd() * 0.3) * (reckless ? 1.25 : 1);
      if (kind === 'ped') a.lat = (rnd() < 0.5 ? -1 : 1) * (w.half + 1.4);
      return a;
    }
    return null;
  }

  private laneOffset(a: Agent, ctx: TrafficCtx): number {
    if (a.kind === 'ped') return a.lat;
    if (a.kind === 'train') return 0;
    // lat is measured to the right of the direction of travel, so left-hand traffic is negative
    const base = ctx.driveSide;
    const half = a.way.half;
    const off = a.kind === 'bike' || a.kind === 'cycle' ? half * 0.7 : half * 0.38;
    return base * off;
  }

  private step(ctx: TrafficCtx, dt: number) {
    const byWay = new Map<Way, Agent[]>();
    for (const a of this.agents) {
      if (a.kind === 'ped' || a.kind === 'train') continue;
      let l = byWay.get(a.way);
      if (!l) byWay.set(a.way, (l = []));
      l.push(a);
    }
    const wf = WEATHER_SPEED[ctx.weather] ?? 1;
    for (const a of this.agents) {
      if (a.dead) continue;
      const w = a.way;
      if (w.dead) {
        a.dead = true;
        continue;
      }
      if (Math.hypot(a.x - this.px, a.y - this.py) > 330) {
        a.dead = true;
        continue;
      }
      if (a.kind === 'train') {
        const toEnd = a.dir > 0 ? w.len - a.s : a.s - a.cars * 22;
        const vd = Math.min(a.v0, Math.sqrt(2 * 0.9 * Math.max(0, toEnd)) + 0.6);
        a.v += Math.max(-1.2, Math.min(0.8, vd - a.v)) * dt;
        a.v = Math.max(0, a.v);
        a.s += a.dir * a.v * dt;
        if (a.dir > 0 && a.s >= w.len - 0.5) {
          a.dir = -1;
          a.pause = 6 + this.rnd() * 6;
        } else if (a.dir < 0 && a.s <= a.cars * 22 + 0.5) {
          a.dir = 1;
          a.pause = 6 + this.rnd() * 6;
        }
        if (a.pause > 0) {
          a.pause -= dt;
          a.v = 0;
          a.s = Math.max(a.cars * 22, Math.min(w.len, a.s));
        }
        this.pose(a, ctx, dt);
        continue;
      }

      let vd = a.v0 * (a.kind === 'ped' ? 1 : wf);
      a.brake = false;
      if (a.kind === 'ped') {
        if (a.pause > 0) {
          a.pause -= dt;
          vd = 0;
        } else if (this.rnd() < dt * 0.02) a.pause = 2 + this.rnd() * 5;
      } else {
        const list = byWay.get(w);
        let gap = Infinity;
        let lv = 0;
        if (list) {
          for (const b of list) {
            if (b === a || b.dir !== a.dir) continue;
            const d = (b.s - a.s) * a.dir;
            if (d <= 0) continue;
            const g = d - (a.len + b.len) / 2;
            if (g < gap) {
              gap = g;
              lv = b.v;
            }
          }
        }
        if (gap < 60) vd = Math.min(vd, Math.max(0, lv + (gap - 3.2) * 0.9));
      }
      // lights, crossings
      const stopFor = (d: number, line: number) => {
        const sd = d - line;
        if (sd > -1) vd = Math.min(vd, Math.sqrt(2 * 3.2 * Math.max(0, sd)));
      };
      for (const arm of w.juncs) {
        const d = (arm.s - a.s) * a.dir;
        if (d < 0 || d > 70) continue;
        if (arm.j.signal && (a.obeys || a.kind === 'ped')) {
          const st = signalState(arm.j, arm.group, this.clock);
          const canStop = d > (a.v * a.v) / (2 * 4) + 2;
          if (a.kind !== 'ped' && (st === 'red' || (st === 'amber' && canStop)) && d > 6) stopFor(d, 7.5);
        }
      }
      for (const cr of w.cross) {
        const d = (cr.s - a.s) * a.dir;
        if (d < -1 || d > 80 || cr.closed < 0.05) continue;
        if (a.obeys) stopFor(d, a.kind === 'ped' ? 3 : 8.5);
        else if (d < 6 && a.kind !== 'ped') vd = Math.max(vd, 9);
      }
      const acc = Math.max(-7, Math.min(2.4, (vd - a.v) / 0.9));
      a.v = Math.max(0, a.v + acc * dt);
      a.brake = acc < -1.2 || (a.v < 0.2 && vd < 0.2);
      this.advance(a, ctx, a.v * dt);
      if (!a.dead) this.pose(a, ctx, dt);
    }
    this.agents = this.agents.filter((a) => !a.dead);
  }

  /** moves along the way, taking turns at junctions and at road ends */
  private advance(a: Agent, ctx: TrafficCtx, ds: number) {
    const w = a.way;
    const from = a.s;
    const to = a.s + a.dir * ds;
    const turnP = a.kind === 'ped' ? 0.4 : 0.3;
    let turned = false;
    for (const arm of w.juncs) {
      const inside = a.dir > 0 ? arm.s > from && arm.s <= to : arm.s < from && arm.s >= to;
      const atEnd = a.dir > 0 ? to >= w.len - 0.01 && arm.s >= w.len - 3 : to <= 0.01 && arm.s <= 3;
      if (!inside && !atEnd) continue;
      const others = arm.j.arms.filter((m) => m.way !== w && (a.kind === 'ped' || !m.way.rail));
      if (!others.length) continue;
      if (this.rnd() < turnP || atEnd) {
        const o = others[Math.floor(this.rnd() * others.length)];
        const dirs: (1 | -1)[] = o.way.oneway === 1 ? [1] : o.way.oneway === -1 ? [-1] : [1, -1];
        const nd = dirs[Math.floor(this.rnd() * dirs.length)];
        if (a.kind !== 'ped' && o.way.oneway !== 0 && nd !== (o.way.oneway as 1 | -1)) continue;
        a.way = o.way;
        a.s = o.s;
        a.dir = nd;
        a.v *= a.kind === 'ped' ? 1 : 0.65;
        if (a.kind === 'ped') a.lat = (this.rnd() < 0.5 ? -1 : 1) * (o.way.half + 1.4);
        if (a.kind === 'bus' && (o.way.cls === 'service' || o.way.cls === 'minor')) {
          a.dead = true;
        }
        turned = true;
        break;
      }
    }
    if (turned) return;
    if (to < 0 || to > w.len) {
      a.dead = true;
      return;
    }
    a.s = to;
    void ctx;
  }

  private pose(a: Agent, ctx: TrafficCtx, dt: number) {
    const [x, y, tx, ty] = this.sample(a.way, a.s);
    const ux = tx * a.dir;
    const uy = ty * a.dir;
    const lat = this.laneOffset(a, ctx);
    const tgtX = x + uy * lat;
    const tgtY = y - ux * lat;
    const k = a.kind === 'ped' ? 1 : Math.min(1, dt * 9);
    a.x += (tgtX - a.x) * k;
    a.y += (tgtY - a.y) * k;
    const kh = Math.min(1, dt * 7);
    a.hx += (ux - a.hx) * kh;
    a.hy += (uy - a.hy) * kh;
    const L = Math.hypot(a.hx, a.hy) || 1;
    a.hx /= L;
    a.hy /= L;
  }

  update(ctx: TrafficCtx, realDt: number) {
    if (!this.lat0) {
      this.lat0 = ctx.lat;
      this.lon0 = ctx.lon;
      this.kx = RAD * EARTH_R * Math.cos(ctx.lat * RAD);
    }
    const [px, py] = this.enu(ctx.lat, ctx.lon);
    this.px = px;
    this.py = py;
    const dt = ctx.paused ? 0 : Math.min(0.1, realDt);

    this.gatherT += realDt;
    if (this.gatherT > 3) {
      this.gatherT = 0;
      for (const f of ctx.roads()) this.addWay(f, false);
      for (const f of ctx.rails()) {
        // leave the player's own track (and anything that touches it) alone
        const pts = f.coords;
        if (pts.length < 2) continue;
        let onRoute = false;
        for (const idx of [0, Math.floor(pts.length / 2), pts.length - 1]) {
          const [lo, la] = pts[idx];
          const q = this.enu(la, lo);
          for (let s = Math.max(0, ctx.s - 200); s < ctx.s + 300 && !onRoute; s += 6) {
            const [pla, plo] = ctx.pointAt(s);
            const r = this.enu(pla, plo);
            if (Math.hypot(r[0] - q[0], r[1] - q[1]) < 3.8) onRoute = true;
          }
        }
        if (!onRoute) this.addWay(f, true);
      }
      for (const [k, w] of this.ways) {
        if (w.bbox[0] > this.px + 520 || w.bbox[2] < this.px - 520 || w.bbox[1] > this.py + 520 || w.bbox[3] < this.py - 520) {
          w.dead = true;
          this.ways.delete(k);
          this.dirty = true;
        }
      }
      if (this.dirty) {
        this.rebuildJunctions();
        this.rebuildCrossings(ctx);
      }
    }
    if (Math.abs(ctx.s - this.crossAt) > 80) this.rebuildCrossings(ctx);

    // level crossings close as the train approaches and reopen once it has cleared
    for (const cr of this.crossings) {
      const delta = cr.routeS - ctx.s;
      const want = delta > -(ctx.trainLength + 10) && delta < 170 ? 1 : 0;
      cr.closed += Math.max(-1, Math.min(1, want - cr.closed)) * Math.min(1, dt / 2.5);
    }
    this.clock += dt;

    // population follows the conditions: fewer people in rain, heat and the small hours
    const wet = ctx.weather === 'rain' || ctx.weather === 'storm';
    const hot = Number.isFinite(ctx.temp) && ctx.temp >= 34 && ctx.night < 0.3;
    const pedTarget = Math.round(24 * ctx.density * (ctx.night > 0.55 ? 0.4 : 1) * (wet ? 0.5 : 1) * (hot ? 0.6 : 1) * (ctx.weather === 'snow' ? 0.5 : 1));
    const vehTarget = Math.round(26 * ctx.density * (ctx.night > 0.55 ? 0.7 : 1) * (ctx.weather === 'storm' ? 0.65 : 1));
    const trainTarget = ctx.density < 1 ? 1 : 2;
    const count = (f: (a: Agent) => boolean) => this.agents.reduce((n, a) => n + (f(a) ? 1 : 0), 0);
    if (this.ways.size && dt > 0) {
      if (count((a) => a.kind !== 'ped' && a.kind !== 'train') < vehTarget) {
        const r = this.rnd();
        const kind: Kind = r < 0.36 ? 'car' : r < 0.58 ? 'taxi' : r < 0.65 ? 'bus' : r < 0.8 ? 'auto' : r < 0.94 ? 'bike' : wet ? 'car' : 'cycle';
        const a = this.spawn(ctx, kind, 70, 260);
        if (a) this.agents.push(a);
      }
      if (count((a) => a.kind === 'ped') < pedTarget) {
        const a = this.spawn(ctx, 'ped', 25, 200);
        if (a) this.agents.push(a);
      }
      if (count((a) => a.kind === 'train') < trainTarget) {
        const a = this.spawn(ctx, 'train', 60, 280);
        if (a) this.agents.push(a);
      }
    }
    // pedestrians who no longer suit the weather put umbrellas up
    for (const a of this.agents) if (a.kind === 'ped' && !a.umbrella && wet && this.rnd() < dt * 0.4) a.umbrella = UMBRELLA[a.seed % UMBRELLA.length];
    this.step(ctx, dt);
  }

  // ------------------------------------------------------------------ meshes
  build(mb: MeshBuilder, ctx: TrafficCtx, view: V2) {
    const z0 = ctx.groundZ + 0.04;
    const lightsOn = ctx.night > 0.3 || ctx.weather === 'rain' || ctx.weather === 'storm' || ctx.weather === 'fog' || ctx.weather === 'snow';
    const loc = (a: { x: number; y: number; hx: number; hy: number }, f: number, l: number): V2 => [a.x - view[0] + a.hx * f + a.hy * l, a.y - view[1] + a.hy * f - a.hx * l];
    const box = (a: Agent, f0: number, f1: number, l: number, hw: number, zb: number, zt: number, col: C4, e = 0, top: C4 | null = null) => {
      mb.segBox(loc(a, f1, l), loc(a, f0, l), hw, z0 + zb, z0 + zt, col, e, top);
    };
    // tapered cabin / canopy outline given as (along, across) points
    const outline = (a: Agent, pts: [number, number][], zb: number, zt: number, col: C4, e: number, top: C4 | null) => {
      mb.prism(pts.map(([f, l]) => loc(a, f, l)), z0 + zb, z0 + zt, col, e, top);
    };
    const shadow = (a: Agent, f0: number, f1: number, hw: number) => {
      mb.flat([loc(a, f0, -hw), loc(a, f1, -hw), loc(a, f1, hw), loc(a, f0, hw)], z0 + 0.025, K.shadow, 2);
    };
    const wheel = (a: Agent, f: number, l: number, r: number, detail: boolean) => {
      box(a, f - r, f + r, l, 0.13, 0, r * 2, K.tyre);
      if (detail) box(a, f - r * 0.45, f + r * 0.45, l + Math.sign(l) * 0.1, 0.03, r * 0.55, r * 1.45, K.hub);
    };
    // level of detail: full fittings close up, simple shapes in the middle distance, a single block far away
    const lowD = ctx.density < 1;
    const NEAR2 = (lowD ? 50 : 80) ** 2;
    const MID2 = (lowD ? 95 : 140) ** 2;
    const FAR2 = (lowD ? 190 : 260) ** 2;
    for (const a of this.agents) {
      const dx = a.x - view[0];
      const dy = a.y - view[1];
      const d2 = dx * dx + dy * dy;
      if (d2 > FAR2) continue;
      const near = d2 < NEAR2;
      const mid = d2 < MID2;
      const back = a.brake ? K.tail : lightsOn ? K.tail : K.tailOff;
      const backE = a.brake || lightsOn ? 2 : 0;
      const headC = lightsOn ? K.head : K.headOff;
      const headE = lightsOn ? 2 : 0.4;
      // each vehicle gets its own paint shade so a street doesn't read as clones
      const body = tone(a.color, 0.9 + (a.seed % 7) * 0.025);
      switch (a.kind) {
        case 'car':
        case 'taxi': {
          const L = a.len / 2;
          const taxi = a.kind === 'taxi';
          if (mid) shadow(a, -L - 0.15, L + 0.15, 0.95);
          if (mid) for (const sf of [-L * 0.62, L * 0.62]) for (const sl of [-0.78, 0.78]) wheel(a, sf, sl, 0.31, near);
          // lower body in two tones: painted upper panel over a dark rocker/skirt
          box(a, -L, L, 0, 0.88, 0.28, 0.46, K.bumper);
          box(a, -L, L, 0, 0.885, 0.46, 0.92, body, 0, tone(body, 1.08));
          // tapered glasshouse with body-coloured roof
          outline(a, [[-L * 0.42, -0.74], [-L * 0.42, 0.74], [-0.05, 0.8], [L * 0.2, 0.7], [L * 0.2, -0.7], [-0.05, -0.8]], 0.92, 1.47, K.glass, 0.6, taxi ? K.taxiRoof : tone(body, 1.1));
          if (near) {
            // pillars, door seams, mirrors, bumpers, grille, plates
            for (const f of [-L * 0.1, L * 0.02]) box(a, f - 0.04, f + 0.04, 0, 0.805, 0.92, 1.45, tone(body, 0.8));
            for (const sl of [-1, 1]) {
              box(a, L * 0.12 - 0.05, L * 0.12 + 0.05, sl * 0.89, 0.005, 0.5, 0.9, tone(body, 0.7));
              box(a, -L * 0.28 - 0.05, -L * 0.28 + 0.05, sl * 0.89, 0.005, 0.5, 0.9, tone(body, 0.7));
              box(a, L * 0.15, L * 0.28, sl * 0.9, 0.06, 1.0, 1.12, K.mirror);
              box(a, L - 0.06, L + 0.1, sl * 0.62, 0.22, 0.55, 0.72, headC, headE);
              box(a, -L - 0.1, -L + 0.06, sl * 0.66, 0.2, 0.62, 0.78, back, backE);
            }
            box(a, L - 0.02, L + 0.14, 0, 0.8, 0.3, 0.46, K.bumper);
            box(a, -L - 0.14, -L + 0.02, 0, 0.8, 0.3, 0.46, K.bumper);
            box(a, L - 0.02, L + 0.03, 0, 0.4, 0.5, 0.7, K.grille);
            box(a, -L - 0.16, -L - 0.12, 0, 0.26, 0.4, 0.5, K.plate);
            if (taxi) {
              box(a, -0.3, 0.3, 0, 0.32, 1.47, 1.66, K.white, lightsOn ? 2 : 0.8);
              box(a, -L * 0.9, L * 0.9, 0, 0.892, 0.62, 0.7, K.taxiRoof);
            } else if (a.seed % 5 === 0) box(a, -L * 0.8, L * 0.8, 0, 0.892, 0.56, 0.62, K.stripe);
          } else if (mid) {
            for (const sl of [-1, 1]) {
              box(a, L - 0.06, L + 0.02, sl * 0.62, 0.2, 0.55, 0.72, headC, headE);
              box(a, -L - 0.02, -L + 0.06, sl * 0.66, 0.18, 0.62, 0.78, back, backE);
            }
          }
          break;
        }
        case 'bus': {
          const L = a.len / 2;
          if (mid) shadow(a, -L - 0.2, L + 0.2, 1.4);
          if (mid) for (const sf of [-L * 0.58, L * 0.58]) for (const sl of [-1.08, 1.08]) wheel(a, sf, sl, 0.5, near);
          box(a, -L, L, 0, 1.28, 0.34, 0.95, tone(body, 0.72));
          box(a, -L, L, 0, 1.28, 0.95, 3.05, body, 0, K.roofUnit);
          box(a, -L, L, 0, 1.285, 1.0, 1.14, K.stripe);
          if (near) {
            // window bays separated by body pillars, a rear screen and a windscreen
            const bays = 7;
            const span = L * 2 - 1.6;
            for (let i = 0; i < bays; i++) {
              const f0 = -L + 0.6 + (span * i) / bays + 0.1;
              box(a, f0, f0 + span / bays - 0.2, 0, 1.3, 1.3, 2.5, K.glass, ctx.night > 0.3 ? 1.1 : 0.6);
            }
            box(a, L - 0.06, L + 0.03, 0, 1.1, 1.15, 2.6, K.glass, 0.6);
            box(a, -L - 0.03, -L + 0.06, 0, 1.0, 1.4, 2.5, K.glass, 0.6);
            box(a, -L + 0.6, -L + 3.6, 0, 0.8, 3.05, 3.3, K.roofUnit);
            for (const sl of [-1, 1]) {
              box(a, L - 0.4, L - 0.1, sl * 1.45, 0.05, 1.5, 2.1, K.mirror);
              box(a, L - 0.08, L + 0.08, sl * 0.9, 0.22, 0.55, 0.8, headC, headE);
              box(a, -L - 0.08, -L + 0.08, sl * 1.0, 0.2, 0.7, 0.92, back, backE);
            }
            box(a, L - 0.02, L + 0.14, 0, 1.2, 0.34, 0.55, K.bumper);
            box(a, -L - 0.14, -L + 0.02, 0, 1.2, 0.34, 0.55, K.bumper);
            box(a, L - 0.6, L - 0.2, 0, 0.55, 2.6, 2.9, K.amber, 2);
            box(a, -L - 0.2, -L - 0.12, 0, 0.3, 0.5, 0.6, K.plate);
          } else {
            box(a, -L + 0.5, L - 0.2, 0, 1.3, 1.3, 2.5, K.glass, ctx.night > 0.3 ? 1.1 : 0.6);
            if (mid) for (const sl of [-1, 1]) box(a, L - 0.08, L + 0.04, sl * 0.9, 0.2, 0.6, 0.8, headC, headE);
          }
          break;
        }
        case 'auto': {
          const L = a.len / 2;
          if (mid) shadow(a, -L - 0.1, L + 0.1, 0.78);
          if (mid) {
            wheel(a, L * 0.78, 0, 0.22, near);
            wheel(a, -L * 0.62, -0.58, 0.22, near);
            wheel(a, -L * 0.62, 0.58, 0.22, near);
          }
          box(a, -L, L, 0, 0.66, 0.26, 0.58, tone(body, 0.8));
          box(a, -L, L * 0.2, 0, 0.64, 0.58, 0.88, body);
          // canvas hood over the passenger bench, open at the sides
          outline(a, [[-L, -0.62], [-L, 0.62], [L * 0.25, 0.6], [L * 0.38, 0.3], [L * 0.38, -0.3], [L * 0.25, -0.6]], 1.55, 1.72, K.autoRoof, 0, K.autoRoof);
          if (near) {
            for (const sl of [-1, 1]) {
              box(a, -L + 0.06, -L + 0.14, sl * 0.58, 0.04, 0.88, 1.58, K.bumper);
              box(a, L * 0.22, L * 0.3, sl * 0.56, 0.04, 0.88, 1.58, K.bumper);
              box(a, L * 0.3, L * 0.7, sl * 0.3, 0.05, 0.3, 0.6, tone(body, 0.7));
            }
            box(a, -L + 0.1, L * 0.1, 0, 0.5, 0.88, 1.0, tone(body, 0.6));
            box(a, L * 0.3, L * 0.34, 0, 0.34, 0.88, 1.58, K.glass, 0.6);
            box(a, L * 0.46, L * 0.7, 0, 0.14, 0.88, 1.2, K.mirror);
            box(a, -0.05, 0.25, 0, 0.17, 0.88, 1.45, SHIRT[a.seed % SHIRT.length]);
            box(a, 0.02, 0.18, 0, 0.12, 1.45, 1.67, SKIN[a.seed % SKIN.length]);
          }
          box(a, L - 0.05, L + 0.04, 0, 0.16, 0.55, 0.72, headC, headE);
          box(a, -L - 0.03, -L + 0.05, 0, 0.3, 0.55, 0.7, back, backE);
          break;
        }
        case 'bike':
        case 'cycle': {
          const L = a.len / 2;
          const moto = a.kind === 'bike';
          if (mid) shadow(a, -L, L, 0.3);
          if (mid) {
            wheel(a, L * 0.62, 0, 0.32, false);
            wheel(a, -L * 0.62, 0, 0.32, false);
          }
          box(a, -L * 0.5, L * 0.4, 0, moto ? 0.2 : 0.05, moto ? 0.45 : 0.55, moto ? 0.92 : 0.66, moto ? body : K.pole);
          // rider: legs, torso, helmet or bare head, a pillion on some bikes
          box(a, -0.1, 0.3, 0, 0.14, 0.5, 0.95, PANTS[a.seed % PANTS.length]);
          box(a, -0.15, 0.2, 0, 0.18, 0.92, 1.42, SHIRT[a.seed % SHIRT.length]);
          box(a, 0.0, 0.2, 0, 0.12, 1.42, 1.66, moto ? tone(body, 0.7) : SKIN[a.seed % SKIN.length]);
          if (near) {
            if (moto) {
              box(a, L * 0.55, L * 0.9, 0, 0.18, 0.9, 1.1, K.mirror);
              box(a, L - 0.05, L + 0.04, 0, 0.1, 0.72, 0.88, headC, headE);
              box(a, -L - 0.04, -L + 0.05, 0, 0.12, 0.65, 0.78, back, backE);
              if (a.seed % 4 === 0) {
                box(a, -0.55, -0.15, 0, 0.16, 0.92, 1.42, SHIRT[(a.seed + 3) % SHIRT.length]);
                box(a, -0.5, -0.3, 0, 0.11, 1.42, 1.64, SKIN[(a.seed + 1) % SKIN.length]);
              }
            } else box(a, 0.15, 0.35, 0, 0.3, 0.98, 1.0, K.pole);
          }
          break;
        }
        case 'ped': {
          const h = 1.5 + (a.seed % 5) * 0.07;
          const moving = a.v > 0.1;
          const sw = moving ? Math.sin(this.clock * 6.5 + a.seed) * 0.16 : 0;
          const bob = moving ? Math.abs(Math.sin(this.clock * 6.5 + a.seed)) * 0.025 : 0;
          const pants = PANTS[a.seed % PANTS.length];
          if (near) {
            // legs and arms swing against each other
            box(a, sw - 0.07, sw + 0.07, -0.08, 0.06, 0, h * 0.5, pants);
            box(a, -sw - 0.07, -sw + 0.07, 0.08, 0.06, 0, h * 0.5, pants);
            box(a, -0.1, 0.1, 0, 0.15, h * 0.5 + bob, h - 0.3 + bob, a.color);
            box(a, -sw * 0.8 - 0.05, -sw * 0.8 + 0.05, -0.21, 0.04, h * 0.5 + bob, h - 0.32 + bob, tone(a.color, 0.85));
            box(a, sw * 0.8 - 0.05, sw * 0.8 + 0.05, 0.21, 0.04, h * 0.5 + bob, h - 0.32 + bob, tone(a.color, 0.85));
            box(a, -0.07, 0.07, 0, 0.1, h - 0.3 + bob, h + bob, a.skin);
            box(a, -0.09, 0.05, 0, 0.105, h - 0.08 + bob, h + 0.03 + bob, HAIR[a.seed % HAIR.length]);
            if (a.seed % 4 === 0) box(a, -0.2, -0.08, 0.2, 0.08, h * 0.5 + bob, h - 0.15 + bob, PANTS[(a.seed + 2) % PANTS.length]);
          } else if (mid) {
            box(a, -0.1, 0.1, 0, 0.14, bob, h - 0.3 + bob, a.color);
            box(a, -0.07, 0.07, 0, 0.1, h - 0.3 + bob, h + bob, a.skin);
          } else box(a, -0.1, 0.1, 0, 0.14, 0, h, a.color);
          if (a.umbrella && mid) {
            const cx = a.x - view[0];
            const cy = a.y - view[1];
            const R = 0.55;
            const ring: V2[] = [];
            for (let i = 0; i < 8; i++) ring.push([cx + Math.cos((i / 8) * Math.PI * 2) * R, cy + Math.sin((i / 8) * Math.PI * 2) * R]);
            mb.prism(ring, z0 + h + 0.1, z0 + h + 0.2, a.umbrella);
            box(a, -0.02, 0.02, 0, 0.02, h - 0.3, h + 0.1, K.pole);
          }
          break;
        }
        case 'train': {
          const lit = ctx.night > 0.3;
          for (let i = 0; i < a.cars; i++) {
            // each car sits further along the way, on the same rail line
            const off = i * 22;
            const [cx, cy, tx, ty] = this.sample(a.way, a.s - a.dir * off);
            const car = { x: cx, y: cy, hx: tx * a.dir, hy: ty * a.dir };
            const bx = (f0: number, f1: number, hw: number, zb: number, zt: number, col: C4, e = 0, top: C4 | null = null) =>
              mb.segBox(loc(car, f1, 0), loc(car, f0, 0), hw, z0 + 0.3 + zb, z0 + 0.3 + zt, col, e, top);
            if (mid) mb.flat([loc(car, -10.5, -1.6), loc(car, 10.5, -1.6), loc(car, 10.5, 1.6), loc(car, -10.5, 1.6)], z0 + 0.03, K.shadow, 2);
            bx(-10, 10, 1.45, 0.5, 3.4, K.train, 0, K.roofUnit);
            bx(-10, 10, 1.47, 1.1, 2.3, K.glass, lit ? 1.1 : 0.6);
            bx(-10, 10, 1.46, 0.5, 0.85, K.trainBand);
            if (near) {
              // doors, bogies, roof equipment and cab ends
              for (const f of [-7.5, -2.5, 2.5, 7.5]) bx(f - 0.75, f + 0.75, 1.49, 0.6, 2.5, K.door, 0.3);
              for (const f of [-6.5, 6.5]) bx(f - 1.2, f + 1.2, 0.15, -0.25, 0.5, K.tyre);
              bx(-6, -2, 0.7, 3.4, 3.7, K.roofUnit);
              bx(2, 6, 0.7, 3.4, 3.7, K.roofUnit);
              if (i === 1 || a.cars === 1) {
                bx(-0.5, 0.5, 0.9, 3.4, 3.6, K.pole);
                bx(-0.2, 0.2, 0.05, 3.6, 4.5, K.pole);
              }
              if (i === 0) {
                bx(9.6, 10.15, 1.2, 1.0, 2.6, K.glass, 0.6);
                for (const sl of [-1, 1]) {
                  mb.segBox(loc(car, 10.15, sl * 1.1), loc(car, 9.8, sl * 1.1), 0.2, z0 + 1.0, z0 + 1.2, lit ? K.head : K.headOff, lit ? 2 : 0.4);
                }
                bx(9.8, 10.1, 0.5, 2.6, 2.9, K.amber, 2);
              }
            } else if (i === 0) {
              bx(9.8, 10.1, 0.5, 2.5, 2.8, K.amber, 2);
            }
          }
          break;
        }
      }
    }

    // traffic lights
    for (const j of this.juncs) {
      if (!j.signal) continue;
      const jx = j.x - view[0];
      const jy = j.y - view[1];
      if (jx * jx + jy * jy > 170 * 170) continue;
      for (const arm of j.arms) {
        for (const dir of [1, -1] as const) {
          if (arm.way.oneway !== 0 && arm.way.oneway !== dir) continue;
          const s = arm.s - dir * 7.5;
          if (s < 0 || s > arm.way.len) continue;
          const [x, y, tx, ty] = this.sample(arm.way, s);
          const ux = tx * dir;
          const uy = ty * dir;
          const off = arm.way.half + 0.9;
          const hx = x + uy * off - view[0];
          const hy = y - ux * off - view[1];
          const st = signalState(j, arm.group, this.clock);
          mb.segBox([hx + ux * 0.1, hy + uy * 0.1], [hx - ux * 0.1, hy - uy * 0.1], 0.07, z0, z0 + 3.4, K.pole);
          const head = { x: hx, y: hy, hx: ux, hy: uy };
          const lamp = (zb: number, col: C4, on: boolean) => {
            mb.segBox([head.x + ux * 0.28, head.y + uy * 0.28], [head.x + ux * 0.14, head.y + uy * 0.14], 0.12, z0 + zb, z0 + zb + 0.22, on ? col : K.lampOff, on ? 2 : 0);
          };
          mb.segBox([head.x + ux * 0.2, head.y + uy * 0.2], [head.x - ux * 0.05, head.y - uy * 0.05], 0.17, z0 + 3.0, z0 + 4.15, K.black);
          lamp(3.9, K.red, st === 'red');
          lamp(3.6, K.amber, st === 'amber');
          lamp(3.3, K.green, st === 'green');
        }
      }
    }

    // level crossing barriers and flashing lights
    for (const cr of this.crossings) {
      const cx = cr.x - view[0];
      const cy = cr.y - view[1];
      if (cx * cx + cy * cy > 200 * 200) continue;
      const w = cr.way;
      const [, , tx, ty] = this.sample(w, cr.s);
      const nx = ty;
      const ny = -tx;
      const flash = cr.closed > 0.1 && Math.floor(this.clock * 2.2) % 2 === 0;
      for (const side of [-1, 1]) {
        const bx = cx + tx * side * 5.2 + nx * (w.half + 0.7);
        const by = cy + ty * side * 5.2 + ny * (w.half + 0.7);
        mb.segBox([bx + nx * 0.1, by + ny * 0.1], [bx - nx * 0.1, by - ny * 0.1], 0.1, z0, z0 + 2.4, K.pole);
        mb.segBox([bx + nx * 0.1, by + ny * 0.1], [bx - nx * 0.1, by - ny * 0.1], 0.22, z0 + 2.3, z0 + 2.7, flash ? K.red : K.lampOff, flash ? 2 : 0);
        // the arm lowers across the carriageway as the crossing closes
        const reach = w.half * 2 + 0.9;
        const dropped = cr.closed > 0.5;
        if (dropped) {
          for (let i = 0; i < 6; i++) {
            const t0 = (i / 6) * reach;
            const t1 = ((i + 1) / 6) * reach;
            mb.segBox([bx - nx * t1, by - ny * t1], [bx - nx * t0, by - ny * t0], 0.06, z0 + 0.95, z0 + 1.05, i % 2 ? K.barrierRed : K.barrier);
          }
        } else {
          mb.segBox([bx, by], [bx + 0.001, by], 0.06, z0 + 2.7, z0 + 2.8, K.barrier);
        }
      }
    }
  }
}
