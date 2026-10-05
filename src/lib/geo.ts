export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bearing in radians, clockwise from north. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return Math.atan2(y, x);
}

/** Local east/north metres relative to an origin (equirectangular, fine for a few km). */
export function toENU(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  return [(lon - lon0) * RAD * EARTH_R * Math.cos(lat0 * RAD), (lat - lat0) * RAD * EARTH_R];
}

export function fromENU(x: number, y: number, lat0: number, lon0: number): [number, number] {
  return [lat0 + y / (RAD * EARTH_R), lon0 + x / (RAD * EARTH_R * Math.cos(lat0 * RAD))];
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest signed angle difference b - a in radians. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * A polyline parameterised by distance. All lookups are O(log n) with a
 * moving hint that makes sequential access (the vehicle) effectively O(1).
 */
export class RoutePath {
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  private hint = 0;

  constructor(lat: ArrayLike<number>, lon: ArrayLike<number>) {
    const n = lat.length;
    this.lat = Float64Array.from(lat);
    this.lon = Float64Array.from(lon);
    this.cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      this.cum[i] = this.cum[i - 1] + haversine(this.lat[i - 1], this.lon[i - 1], this.lat[i], this.lon[i]);
    }
    this.length = n > 0 ? this.cum[n - 1] : 0;
  }

  /** Segment index i such that cum[i] <= s < cum[i+1]. */
  segmentAt(s: number): number {
    const c = this.cum;
    const n = c.length;
    if (n < 2) return 0;
    let i = this.hint;
    if (i >= n - 1) i = n - 2;
    if (s >= c[i] && s <= c[i + 1]) return i;
    if (s > c[i + 1] && i + 2 < n && s <= c[i + 2]) return (this.hint = i + 1);
    let lo = 0;
    let hi = n - 2;
    if (s <= 0) return (this.hint = 0);
    if (s >= c[n - 1]) return (this.hint = n - 2);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return (this.hint = lo);
  }

  /** Point at distance s; extrapolates linearly beyond both ends. */
  pointAt(s: number): [number, number] {
    const n = this.cum.length;
    if (n === 0) return [0, 0];
    if (n === 1) return [this.lat[0], this.lon[0]];
    const i = this.segmentAt(s);
    const segLen = this.cum[i + 1] - this.cum[i] || 1e-9;
    const t = (s - this.cum[i]) / segLen;
    return [
      this.lat[i] + (this.lat[i + 1] - this.lat[i]) * t,
      this.lon[i] + (this.lon[i + 1] - this.lon[i]) * t,
    ];
  }

  headingAt(s: number, span = 8): number {
    const [la, lo] = this.pointAt(s - span);
    const [lb, lob] = this.pointAt(s + span);
    return bearing(la, lo, lb, lob);
  }

  /** Fast projection limited to a window of ±`win` metres around `sHint` (for tracking a moving vehicle). */
  projectNear(lat: number, lon: number, sHint: number, win: number): { s: number; d: number } {
    const n = this.cum.length;
    const i0 = this.segmentAt(sHint - win);
    const i1 = Math.min(n - 2, this.segmentAt(sHint + win));
    let best = { s: sHint, d: Infinity };
    for (let i = i0; i <= i1; i++) {
      const [ax, ay] = toENU(this.lat[i], this.lon[i], lat, lon);
      const [bx, by] = toENU(this.lat[i + 1], this.lon[i + 1], lat, lon);
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const t = clamp(L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0, 0, 1);
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d < best.d) best = { s: this.cum[i] + (this.cum[i + 1] - this.cum[i]) * t, d };
    }
    this.segmentAt(sHint);
    return best;
  }

  /**
   * Project a point onto the path, preferring positions at or after `minS`.
   * Returns distance along path and perpendicular distance.
   */
  project(lat: number, lon: number, minS = -Infinity, aheadPenalty = 0): { s: number; d: number } {
    const n = this.cum.length;
    let best = { s: 0, d: Infinity };
    let bestCost = Infinity;
    for (let i = 0; i < n - 1; i++) {
      if (this.cum[i + 1] < minS) continue;
      const [ax, ay] = toENU(this.lat[i], this.lon[i], lat, lon);
      const [bx, by] = toENU(this.lat[i + 1], this.lon[i + 1], lat, lon);
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
      t = clamp(t, 0, 1);
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d = Math.hypot(px, py);
      const s = this.cum[i] + (this.cum[i + 1] - this.cum[i]) * t;
      if (s < minS) continue;
      const cost = d + (isFinite(minS) ? Math.max(0, s - minS) * aheadPenalty : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = { s, d };
      }
    }
    return best;
  }
}
