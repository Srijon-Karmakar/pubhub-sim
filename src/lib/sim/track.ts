import type { RouteData, WaySpan } from '../../types';
import { RoutePath, toENU } from '../geo';
import type { VehicleProfile } from './profiles';
import { vehicleLength } from './profiles';

const STEP = 10;

interface Span {
  s0: number;
  s1: number;
}

function mergeSpans(spans: Span[], gap: number, minLen: number): Span[] {
  const out: Span[] = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp.s0 - last.s1 <= gap) last.s1 = Math.max(last.s1, sp.s1);
    else out.push({ ...sp });
  }
  return out.filter((s) => s.s1 - s.s0 >= minLen);
}

/**
 * Everything the simulator and renderer need to know about the line:
 * geometry, speed restrictions, tunnels and viaducts.
 */
export class Track {
  readonly path: RoutePath;
  readonly length: number;
  readonly limS: number[] = [];
  readonly limV: number[] = [];
  /** curve-only limit per 10 m (for lateral comfort) */
  readonly curveV: Float32Array;
  readonly elev: Float32Array;
  readonly tunnels: Span[];
  readonly bridges: Span[];
  readonly ways: WaySpan[];

  constructor(
    route: RouteData,
    readonly profile: VehicleProfile,
  ) {
    this.path = new RoutePath(route.lat, route.lon);
    this.length = this.path.length;
    this.ways = route.ways;
    const N = Math.max(2, Math.ceil(this.length / STEP) + 1);

    // --- curvature ---------------------------------------------------
    const lat0 = route.lat[0];
    const lon0 = route.lon[0];
    const xs = new Float64Array(N);
    const ys = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const [la, lo] = this.path.pointAt(Math.min(i * STEP, this.length));
      const [x, y] = toENU(la, lo, lat0, lon0);
      xs[i] = x;
      ys[i] = y;
    }
    this.curveV = new Float32Array(N);
    const k = 3;
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - k);
      const c = Math.min(N - 1, i + k);
      if (c - a < 2) {
        this.curveV[i] = profile.vmax;
        continue;
      }
      const abx = xs[i] - xs[a];
      const aby = ys[i] - ys[a];
      const bcx = xs[c] - xs[i];
      const bcy = ys[c] - ys[i];
      const acx = xs[c] - xs[a];
      const acy = ys[c] - ys[a];
      const cross = Math.abs(abx * acy - aby * acx);
      const lab = Math.hypot(abx, aby);
      const lbc = Math.hypot(bcx, bcy);
      const lac = Math.hypot(acx, acy);
      const R = cross < 1e-6 ? Infinity : (lab * lbc * lac) / (2 * cross);
      this.curveV[i] = Math.min(profile.vmax, Math.sqrt(profile.latAccel * R));
    }

    // --- raw limit -----------------------------------------------------
    const raw = new Float64Array(N);
    let wi = 0;
    for (let i = 0; i < N; i++) {
      const s = i * STEP;
      while (wi < this.ways.length - 1 && this.ways[wi].s1 < s) wi++;
      const tag = this.ways[wi]?.maxspeed ?? profile.defaultLimit;
      raw[i] = Math.max(profile.minLimit, Math.min(profile.vmax, this.curveV[i], tag));
    }
    // the whole train must respect a restriction until the rear clears it
    const L = vehicleLength(profile);
    const back = Math.ceil(L / STEP) + 1;
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let m = Infinity;
      for (let j = Math.max(0, i - back); j <= Math.min(N - 1, i + 2); j++) m = Math.min(m, raw[j]);
      win[i] = m;
    }
    // quantise: 10 km/h steps on heavy rail (5 below 40), 5 km/h elsewhere
    const coarse = profile.rail && route.mode !== 'tram' && route.mode !== 'light_rail';
    const q = (v: number) => {
      const k = v * 3.6;
      const step = coarse && k >= 40 ? 10 : 5;
      return (Math.floor(k / step + 1e-6) * step) / 3.6;
    };
    const segS: number[] = [];
    const segV: number[] = [];
    for (let i = 0; i < N; i++) {
      const v = q(win[i]);
      if (!segV.length || Math.abs(segV[segV.length - 1] - v) > 1e-6) {
        segS.push(i * STEP);
        segV.push(v);
      }
    }
    // absorb short "spikes" above both neighbours (never raises a limit),
    // and merge staircases (75→70→60) into their lowest step
    const minLen = coarse ? 300 : profile.rail ? 160 : 100;
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (let i = 0; i < segV.length; i++) {
        const end = i + 1 < segS.length ? segS[i + 1] : this.length;
        const len = end - segS[i];
        if (len >= minLen) continue;
        const prev = i > 0 ? segV[i - 1] : -1;
        const next = i + 1 < segV.length ? segV[i + 1] : -1;
        if (segV[i] > prev && segV[i] > next) {
          segV[i] = Math.max(prev, next);
          changed = true;
        } else if (prev >= 0 && next >= 0 && ((segV[i] < prev && segV[i] > next) || (segV[i] > prev && segV[i] < next))) {
          // a short intermediate step: fold into the lower neighbour
          segV[i] = Math.min(prev, next);
          changed = true;
        }
      }
      for (let i = segV.length - 1; i > 0; i--) {
        if (Math.abs(segV[i] - segV[i - 1]) < 1e-6) {
          segV.splice(i, 1);
          segS.splice(i, 1);
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.limS = segS;
    this.limV = segV;

    // --- tunnels / viaducts ------------------------------------------------
    this.tunnels = mergeSpans(
      this.ways.filter((w) => w.tunnel),
      60,
      40,
    );
    const elevatedModes = profile.rail && route.mode !== 'tram';
    this.bridges = elevatedModes
      ? mergeSpans(
          this.ways.filter((w) => w.bridge),
          90,
          140,
        )
      : [];
    this.elev = new Float32Array(N);
    const H = 6.5;
    for (let i = 0; i < N; i++) {
      const s = i * STEP;
      const inT = this.tunnels.some((t) => s >= t.s0 && s <= t.s1);
      const inB = this.bridges.some((b) => s >= b.s0 && s <= b.s1);
      this.elev[i] = !inT && (profile.elevated || inB) ? H : 0;
    }
    const g = 0.035 * STEP;
    for (let i = 1; i < N; i++) this.elev[i] = Math.max(this.elev[i], this.elev[i - 1] - g);
    for (let i = N - 2; i >= 0; i--) this.elev[i] = Math.max(this.elev[i], this.elev[i + 1] - g);
  }

  private segIdx(s: number): number {
    const S = this.limS;
    let lo = 0;
    let hi = S.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  limitAt(s: number): number {
    return this.limV[this.segIdx(s)] ?? this.profile.vmax;
  }

  /** First restriction lower than the current one within `horizon` metres. */
  nextLower(s: number, horizon: number): { dist: number; v: number } | null {
    let i = this.segIdx(s);
    const cur = this.limV[i];
    for (i = i + 1; i < this.limS.length; i++) {
      const d = this.limS[i] - s;
      if (d > horizon) break;
      if (this.limV[i] < cur - 1e-6) return { dist: d, v: this.limV[i] };
    }
    return null;
  }

  /** Next limit change of any kind. */
  nextChange(s: number, horizon: number): { dist: number; v: number } | null {
    const i = this.segIdx(s);
    if (i + 1 >= this.limS.length) return null;
    const d = this.limS[i + 1] - s;
    return d <= horizon ? { dist: d, v: this.limV[i + 1] } : null;
  }

  curveLimitAt(s: number): number {
    const i = Math.max(0, Math.min(this.curveV.length - 1, Math.round(s / STEP)));
    return this.curveV[i];
  }

  elevationAt(s: number): number {
    const f = s / STEP;
    const i = Math.floor(f);
    if (i < 0) return this.elev[0];
    if (i >= this.elev.length - 1) return this.elev[this.elev.length - 1];
    const t = f - i;
    return this.elev[i] * (1 - t) + this.elev[i + 1] * t;
  }

  inTunnel(s: number): boolean {
    for (const t of this.tunnels) if (s >= t.s0 && s <= t.s1) return true;
    return false;
  }
}
