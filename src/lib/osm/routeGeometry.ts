import type { Line, RouteData, RouteRef, Stop, WaySpan } from '../../types';
import { normalizeColour, readableText } from '../color';
import { fromENU, haversine, RoutePath, toENU } from '../geo';
import { cacheGet, cacheSet, DAY } from './cache';
import { fetchJson, overpass, type OverpassElement, type OverpassMember } from './http';

interface LL {
  lat: number;
  lon: number;
}
interface P extends LL {
  /** index of the way this point belongs to (-1 = connector) */
  w: number;
}

const dist = (a: LL, b: LL) => haversine(a.lat, a.lon, b.lat, b.lon);
const isPlatformRole = (r: string) => /^platform/.test(r);
const isStopRole = (r: string) => /^stop/.test(r);
const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u;

function displayName(t?: Record<string, string>): string | undefined {
  if (!t) return undefined;
  const n = t.name?.trim();
  const en = t['name:en']?.trim();
  if (n && LATIN.test(n)) return n;
  return en || t['name:latin'] || n || t.ref;
}

function parseMaxspeed(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^\s*(\d+(?:\.\d+)?)\s*(mph|knots)?/i);
  if (!m) return undefined;
  let n = parseFloat(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'mph') n *= 1.609;
  if (unit === 'knots') n *= 1.852;
  if (n < 5 || n > 400) return undefined;
  return n / 3.6;
}

/** Joins ordered way members into a single directed polyline. */
function chainOrdered(ways: LL[][]): { pts: P[]; gap: number } {
  const pts: P[] = [];
  let gap = 0;
  for (let i = 0; i < ways.length; i++) {
    let g = ways[i].slice();
    const closed = g.length > 3 && dist(g[0], g[g.length - 1]) < 0.5;
    if (pts.length === 0) {
      const nx = ways[i + 1];
      if (nx && !closed) {
        const nf = nx[0];
        const nl = nx[nx.length - 1];
        const endC = Math.min(dist(g[g.length - 1], nf), dist(g[g.length - 1], nl));
        const startC = Math.min(dist(g[0], nf), dist(g[0], nl));
        if (startC + 0.5 < endC) g.reverse();
      }
      for (const p of g) pts.push({ ...p, w: i });
      continue;
    }
    let end = pts[pts.length - 1];
    if (closed) {
      // Roundabout: enter at the nearest node, leave where the next way connects.
      const ring = g.slice(0, -1);
      const n = ring.length;
      let k = 0;
      let kd = Infinity;
      ring.forEach((p, j) => {
        const d = dist(p, end);
        if (d < kd) {
          kd = d;
          k = j;
        }
      });
      const nx = ways[i + 1];
      let exit = k;
      if (nx) {
        let ed = Infinity;
        ring.forEach((p, j) => {
          const d = Math.min(dist(p, nx[0]), dist(p, nx[nx.length - 1]));
          if (d < ed) {
            ed = d;
            exit = j;
          }
        });
      }
      gap += kd;
      if (exit !== k) {
        let j = k;
        for (let c = 0; c <= n; c++) {
          const p = ring[j];
          if (dist(p, pts[pts.length - 1]) > 0.3) pts.push({ ...p, w: i });
          if (j === exit) break;
          j = (j + 1) % n;
        }
      }
      continue;
    }
    // The first way's orientation can only be validated against the second.
    if (i === 1 || pts.every((p) => p.w === pts[0].w)) {
      const first = pts[0];
      const dEnd = Math.min(dist(end, g[0]), dist(end, g[g.length - 1]));
      const dStart = Math.min(dist(first, g[0]), dist(first, g[g.length - 1]));
      if (dStart + 0.5 < dEnd) {
        pts.reverse();
        end = pts[pts.length - 1];
      }
    }
    const df = dist(end, g[0]);
    const dl = dist(end, g[g.length - 1]);
    if (dl < df) g = g.reverse();
    const gp = Math.min(df, dl);
    gap += gp;
    for (let j = 0; j < g.length; j++) {
      if (j === 0 && gp < 0.5) continue;
      pts.push({ ...g[j], w: i });
    }
  }
  return { pts, gap };
}

/** Fallback for unordered relations: greedily attach the nearest way end. */
function chainGreedy(ways: LL[][], startHint?: LL): { pts: P[]; gap: number } {
  if (ways.length === 0) return { pts: [], gap: 0 };
  const used = new Array(ways.length).fill(false);
  let cur = 0;
  if (startHint) {
    let bd = Infinity;
    ways.forEach((g, i) => {
      const d = Math.min(dist(g[0], startHint), dist(g[g.length - 1], startHint));
      if (d < bd) {
        bd = d;
        cur = i;
      }
    });
  }
  let first = ways[cur].slice();
  if (startHint && dist(first[first.length - 1], startHint) < dist(first[0], startHint)) first.reverse();
  const pts: P[] = first.map((p) => ({ ...p, w: cur }));
  used[cur] = true;
  let gap = 0;
  for (let k = 1; k < ways.length; k++) {
    const end = pts[pts.length - 1];
    let bi = -1;
    let bd = Infinity;
    let rev = false;
    ways.forEach((g, i) => {
      if (used[i]) return;
      const a = dist(end, g[0]);
      const b = dist(end, g[g.length - 1]);
      if (a < bd) {
        bd = a;
        bi = i;
        rev = false;
      }
      if (b < bd) {
        bd = b;
        bi = i;
        rev = true;
      }
    });
    if (bi < 0 || bd > 1500) break;
    used[bi] = true;
    gap += bd;
    const g = rev ? ways[bi].slice().reverse() : ways[bi];
    g.forEach((p, j) => {
      if (j === 0 && bd < 0.5) return;
      pts.push({ ...p, w: bi });
    });
  }
  return { pts, gap };
}

/** Typical minimum curve radius per mode (m): OSM corners are rounded to at most this. */
const CURVE_R: Record<string, number> = {
  train: 320,
  subway: 220,
  monorail: 160,
  light_rail: 60,
  tram: 28,
  bus: 16,
  trolleybus: 18,
  ferry: 180,
};

/**
 * Rounds every corner of the polyline into an arc (quadratic Bézier through the
 * corner) so vehicles follow smooth curves instead of snapping at OSM vertices.
 * Each arc is clamped to 45% of the adjacent segments so neighbours never overlap.
 */
function filletPath(pts: P[], radius: number): P[] {
  if (pts.length < 3) return pts;
  const out: P[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1];
    const B = pts[i];
    const Cc = pts[i + 1];
    const [ax, ay] = toENU(A.lat, A.lon, B.lat, B.lon);
    const [cx, cy] = toENU(Cc.lat, Cc.lon, B.lat, B.lon);
    const la = Math.hypot(ax, ay);
    const lc = Math.hypot(cx, cy);
    if (la < 0.5 || lc < 0.5) {
      out.push(B);
      continue;
    }
    // unit vectors from B towards A and towards C
    const u1x = ax / la;
    const u1y = ay / la;
    const u2x = cx / lc;
    const u2y = cy / lc;
    const cosInner = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
    const turn = Math.PI - Math.acos(cosInner);
    if (turn < (2 * Math.PI) / 180 || turn > (170 * Math.PI) / 180) {
      out.push(B);
      continue;
    }
    const t = Math.min(radius * Math.tan(turn / 2), la * 0.45, lc * 0.45);
    const p1: [number, number] = [u1x * t, u1y * t];
    const p2: [number, number] = [u2x * t, u2y * t];
    const n = Math.max(2, Math.min(24, Math.ceil(turn / ((6 * Math.PI) / 180))));
    for (let k = 0; k <= n; k++) {
      const q = k / n;
      const w0 = (1 - q) * (1 - q);
      const w2 = q * q;
      const x = w0 * p1[0] + w2 * p2[0];
      const y = w0 * p1[1] + w2 * p2[1];
      const [lat, lon] = fromENU(x, y, B.lat, B.lon);
      out.push({ lat, lon, w: B.w });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Smoothing strength per mode (Gaussian sigma, metres along the line). */
const SMOOTH_SIGMA: Record<string, number> = {
  train: 45,
  subway: 34,
  monorail: 28,
  light_rail: 14,
  tram: 8,
  bus: 4,
  trolleybus: 4,
  ferry: 40,
};

/**
 * Resamples the line at an even spacing, then Gaussian-smooths it. Unlike corner
 * rounding this does not depend on how OSM happened to place its nodes, so long
 * straight ways meeting at a kink still turn into a proper curve. The kernel
 * narrows towards both ends so terminals stay exactly where they are.
 */
function smoothPath(pts: P[], sigma: number): P[] {
  if (pts.length < 3 || sigma <= 0) return pts;
  const total = pathLength(pts);
  const step = Math.max(2, Math.min(sigma / 3, total / 60000));
  // resample
  const rs: P[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    if (seg < 1e-6) continue;
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      rs.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, w: b.w });
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = pts[pts.length - 1];
  if (dist(rs[rs.length - 1], last) > step * 0.3) rs.push(last);
  const n = rs.length;
  const sig = sigma / step;
  const out: P[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // shrink the kernel near the ends so the endpoints stay fixed
    const local = Math.min(sig, i / 3, (n - 1 - i) / 3);
    if (local < 0.5) {
      out[i] = rs[i];
      continue;
    }
    const r = Math.ceil(local * 3);
    let wsum = 0;
    let la = 0;
    let lo = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = Math.exp((-k * k) / (2 * local * local));
      wsum += w;
      la += rs[j].lat * w;
      lo += rs[j].lon * w;
    }
    out[i] = { lat: la / wsum, lon: lo / wsum, w: rs[i].w };
  }
  return out;
}

function pathLength(pts: LL[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

async function osrmThrough(stops: LL[]): Promise<LL[] | null> {
  try {
    const out: LL[] = [];
    for (let i = 0; i < stops.length - 1; i += 39) {
      const chunk = stops.slice(i, i + 40);
      if (chunk.length < 2) break;
      const coords = chunk.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const res = await fetchJson<{ routes: { geometry: { coordinates: [number, number][] } }[] }>(
        `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
        {},
        15000,
      );
      const c = res.routes?.[0]?.geometry.coordinates;
      if (!c) return null;
      for (const [lon, lat] of c) out.push({ lat, lon });
    }
    return out.length > 1 ? out : null;
  } catch {
    return null;
  }
}

interface Candidate extends LL {
  id: string;
  name?: string;
  plat?: LL;
}

interface OsmApiElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[];
  tags?: Record<string, string>;
}

/**
 * One route relation with all its member ways and nodes, from the main
 * OpenStreetMap API (~1 s, very reliable), reshaped into the Overpass
 * "out geom" form the parser expects.
 */
async function fetchFromOsmApi(id: number, signal?: AbortSignal): Promise<OverpassElement[]> {
  const res = await fetchJson<{ elements: OsmApiElement[] }>(`https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`, { signal }, 30000);
  const nodes = new Map<number, LL>();
  const ways = new Map<number, number[]>();
  let rel: OsmApiElement | undefined;
  for (const el of res.elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) nodes.set(el.id, { lat: el.lat, lon: el.lon });
    else if (el.type === 'way' && el.nodes) ways.set(el.id, el.nodes);
    else if (el.type === 'relation' && el.id === id) rel = el;
  }
  if (!rel?.members) throw new Error('Route not found');
  const members: OverpassMember[] = rel.members.map((m) => {
    if (m.type === 'node') return { ...m, ...nodes.get(m.ref) };
    if (m.type === 'way') return { ...m, geometry: (ways.get(m.ref) ?? []).map((n) => nodes.get(n) ?? null) };
    return m;
  });
  return [
    { type: 'relation', id, tags: rel.tags, members },
    ...res.elements.filter((e) => e.type !== 'relation' && e.tags).map((e) => ({ type: e.type, id: e.id, tags: e.tags, lat: e.lat, lon: e.lon })),
  ];
}

export async function fetchRoute(
  ref: RouteRef,
  line: Line,
  driveSide: -1 | 1,
  signal?: AbortSignal,
  onAttempt?: (host: string) => void,
): Promise<RouteData> {
  const key = `route:v6:${ref.id}`;
  const cached = await cacheGet<RouteData>(key, 30 * DAY);
  if (cached) return { ...cached, colour: line.colour, textColour: line.textColour, driveSide };

  let elements: OverpassElement[];
  try {
    onAttempt?.('openstreetmap.org');
    elements = await fetchFromOsmApi(ref.id, signal);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // fall back to Overpass
    const q = `[out:json][timeout:90];
rel(${ref.id})->.r;
.r out geom;
(node(r.r);way(r.r););
out tags;
way(r.r)->.w;
node(w.w)[~"^(railway|public_transport|highway|amenity)$"~"^(station|halt|stop|stop_position|bus_stop|ferry_terminal)$"];
out;`;
    elements = (await overpass(q, { timeoutMs: 35000, staggerMs: 4000, signal, onAttempt: (h) => onAttempt?.(h) })).elements;
  }
  let data = await parseRoute(elements, ref, line, driveSide);
  if (data.synthStops) {
    const extra = await stationsAlong(data, signal).catch(() => []);
    if (extra.length >= 2) {
      const better = await parseRoute(elements, ref, line, driveSide, extra).catch(() => null);
      if (better && !better.synthStops) data = better;
    }
  }
  await cacheSet(key, data);
  return data;
}

/** Stations within a short distance of the route line (for routes whose stops aren't members). */
async function stationsAlong(route: RouteData, signal?: AbortSignal): Promise<Candidate[]> {
  const path = new RoutePath(route.lat, route.lon);
  const road = route.mode === 'bus' || route.mode === 'trolleybus';
  const step = Math.max(300, path.length / 120);
  const coords: string[] = [];
  for (let d = 0; d <= path.length; d += step) {
    const [la, lo] = path.pointAt(d);
    coords.push(`${la.toFixed(5)},${lo.toFixed(5)}`);
  }
  const [la, lo] = path.pointAt(path.length);
  coords.push(`${la.toFixed(5)},${lo.toFixed(5)}`);
  const around = `around:${road ? 35 : route.mode === 'ferry' ? 250 : 150},${coords.join(',')}`;
  const filters = road
    ? [`node(${around})[highway=bus_stop];`, `node(${around})[public_transport=platform][bus=yes];`]
    : route.mode === 'ferry'
      ? [`node(${around})[amenity=ferry_terminal];`, `node(${around})[public_transport=station][ferry=yes];`]
      : [`node(${around})[railway~"^(station|halt)$"];`, `node(${around})[public_transport=station];`];
  const q = `[out:json][timeout:25];(${filters.join('')});out;`;
  const res = await overpass(q, { timeoutMs: 25000, staggerMs: 4000, signal });
  return res.elements
    .filter((e) => e.type === 'node' && e.lat != null && e.lon != null && e.tags?.name)
    .map((e) => ({ id: 'n' + e.id, lat: e.lat!, lon: e.lon!, name: displayName(e.tags) }));
}

export async function parseRoute(
  elements: OverpassElement[],
  ref: RouteRef,
  line: Line,
  driveSide: -1 | 1,
  extraStops?: Candidate[],
): Promise<RouteData> {
  const rel = elements.find((e) => e.type === 'relation' && e.id === ref.id);
  if (!rel?.members) throw new Error('This route could not be found in OpenStreetMap.');
  const tags = new Map<string, Record<string, string>>();
  for (const e of elements) if (e !== rel) tags.set(e.type[0] + e.id, e.tags ?? {});
  const rt = rel.tags ?? {};
  const members: OverpassMember[] = rel.members;

  const wayMembers = members.filter(
    (m) => m.type === 'way' && !isPlatformRole(m.role) && (m.geometry?.filter(Boolean).length ?? 0) >= 2,
  );
  const wayGeoms: LL[][] = wayMembers.map((m) => m.geometry!.filter((p): p is LL => !!p));

  // ---- stop candidates -------------------------------------------------
  const platforms: Candidate[] = [];
  for (const m of members) {
    if (!isPlatformRole(m.role)) continue;
    const t = tags.get(m.type[0] + m.ref);
    if (m.type === 'node' && m.lat != null && m.lon != null) {
      platforms.push({ id: 'n' + m.ref, lat: m.lat, lon: m.lon, name: displayName(t) });
    } else if (m.type === 'way' && m.geometry) {
      const g = m.geometry.filter((p): p is LL => !!p);
      if (!g.length) continue;
      const lat = g.reduce((a, p) => a + p.lat, 0) / g.length;
      const lon = g.reduce((a, p) => a + p.lon, 0) / g.length;
      platforms.push({ id: 'w' + m.ref, lat, lon, name: displayName(t) });
    }
  }
  let cands: Candidate[] = members
    .filter((m) => m.type === 'node' && isStopRole(m.role) && m.lat != null)
    .map((m) => ({ id: 'n' + m.ref, lat: m.lat!, lon: m.lon!, name: displayName(tags.get('n' + m.ref)) }));

  if (cands.length >= 2) {
    for (const c of cands) {
      let best: Candidate | undefined;
      let bd = 90;
      for (const p of platforms) {
        const d = dist(c, p) - (p.name && p.name === c.name ? 40 : 0);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best) {
        c.plat = { lat: best.lat, lon: best.lon };
        c.name ??= best.name;
      }
    }
  } else if (platforms.length >= 2) {
    cands = platforms.map((p) => ({ ...p, plat: { lat: p.lat, lon: p.lon } }));
  } else {
    cands = members
      .filter((m) => m.type === 'node' && m.lat != null)
      .filter((m) => {
        const t = tags.get('n' + m.ref) ?? {};
        return t.public_transport || t.highway === 'bus_stop' || t.railway || t.amenity === 'ferry_terminal';
      })
      .map((m) => ({ id: 'n' + m.ref, lat: m.lat!, lon: m.lon!, name: displayName(tags.get('n' + m.ref)) }));
  }
  // stops not listed as members: stations that sit on the route's own tracks / roads
  let unordered = false;
  if (cands.length < 2) {
    const road = ref.mode === 'bus' || ref.mode === 'trolleybus';
    const onLine = elements
      .filter((e) => e.type === 'node' && e.lat != null && e.lon != null && e.tags?.name)
      .filter((e) => {
        const t = e.tags!;
        if (ref.mode === 'ferry') return t.amenity === 'ferry_terminal' || t.public_transport === 'stop_position';
        if (road) return t.highway === 'bus_stop' || (t.public_transport === 'stop_position' && t.bus === 'yes');
        return /^(station|halt|stop)$/.test(t.railway ?? '') || (t.public_transport === 'stop_position' && t.bus !== 'yes');
      })
      .map((e) => ({ id: 'n' + e.id, lat: e.lat!, lon: e.lon!, name: displayName(e.tags) }));
    if (onLine.length >= 2) {
      cands = onLine;
      unordered = true;
    }
  }
  if (cands.length < 2 && extraStops && extraStops.length >= 2) {
    cands = extraStops;
    unordered = true;
  }

  // ---- geometry -------------------------------------------------------
  let pts: P[] = [];
  let approx = false;
  if (wayGeoms.length) {
    const ordered = chainOrdered(wayGeoms);
    const L = pathLength(ordered.pts);
    pts = ordered.pts;
    if (ordered.gap > Math.max(400, L * 0.15)) {
      const greedy = chainGreedy(wayGeoms, cands[0]);
      if (greedy.gap < ordered.gap * 0.6 && pathLength(greedy.pts) > L * 0.5) pts = greedy.pts;
    }
  }
  if (pts.length < 2 && cands.length >= 2) {
    approx = true;
    const road = ref.mode === 'bus' || ref.mode === 'trolleybus';
    const routed = road ? await osrmThrough(cands) : null;
    pts = (routed ?? cands).map((p) => ({ lat: p.lat, lon: p.lon, w: -1 }));
  }
  // de-duplicate
  const clean: P[] = [];
  for (const p of pts) {
    if (!clean.length || dist(clean[clean.length - 1], p) > 0.3) clean.push(p);
  }
  if (clean.length < 2) throw new Error('This route has no usable geometry in OpenStreetMap yet.');
  const smoothed = smoothPath(filletPath(clean, CURVE_R[ref.mode] ?? 60), SMOOTH_SIGMA[ref.mode] ?? 15);
  clean.length = 0;
  for (const p of smoothed) if (!clean.length || dist(clean[clean.length - 1], p) > 0.3) clean.push(p);

  const path = new RoutePath(
    clean.map((p) => p.lat),
    clean.map((p) => p.lon),
  );
  if (path.length < 150) throw new Error('This route is too short to drive.');

  // ---- way attributes -------------------------------------------------
  const ways: WaySpan[] = [];
  const attrOf = (w: number) => {
    if (w < 0) return { tunnel: false, bridge: false, maxspeed: undefined as number | undefined };
    const t = tags.get('w' + wayMembers[w].ref) ?? {};
    const layer = Number(t.layer ?? 0);
    const tunnel = (!!t.tunnel && t.tunnel !== 'no') || t.location === 'underground' || layer <= -1;
    const bridge = !tunnel && ((!!t.bridge && t.bridge !== 'no') || t.location === 'overground' || (ref.mode !== 'ferry' && layer >= 2));
    return { tunnel, bridge, maxspeed: parseMaxspeed(t.maxspeed) };
  };
  for (let i = 1; i < clean.length; i++) {
    const a = attrOf(clean[i].w);
    const s0 = path.cum[i - 1];
    const s1 = path.cum[i];
    const last = ways[ways.length - 1];
    if (last && last.tunnel === a.tunnel && last.bridge === a.bridge && last.maxspeed === a.maxspeed) last.s1 = s1;
    else ways.push({ s0, s1, ...a });
  }

  // ---- stops -----------------------------------------------------------
  const stops: Stop[] = [];
  let prevS = -Infinity;
  if (unordered) {
    // stations found on/near the line: order them along the path, drop duplicates by name
    const proj = cands.map((c) => ({ c, ...path.project(c.lat, c.lon) })).filter((x) => x.d < 350).sort((a, b) => a.s - b.s);
    const seen: { name: string; s: number }[] = [];
    cands = [];
    for (const x of proj) {
      if (x.c.name && seen.some((q) => q.name === x.c.name && Math.abs(q.s - x.s) < 600)) continue;
      seen.push({ name: x.c.name ?? '', s: x.s });
      cands.push(x.c);
    }
  }
  for (const c of cands) {
    const pr = path.project(c.lat, c.lon, prevS === -Infinity ? -Infinity : prevS - 25, 0.01);
    if (!isFinite(pr.d) || pr.d > 350) continue;
    let side: -1 | 1 = driveSide;
    const ref2 = c.plat ?? c;
    const [plat, plon] = path.pointAt(pr.s);
    const [dx, dy] = toENU(ref2.lat, ref2.lon, plat, plon);
    if (Math.hypot(dx, dy) > 1.2) {
      const h = path.headingAt(pr.s);
      const cross = Math.sin(h) * dy - Math.cos(h) * dx;
      side = cross > 0 ? -1 : 1;
    }
    const prev = stops[stops.length - 1];
    if (prev && pr.s - prev.s < 30) {
      if (!prev.name && c.name) prev.name = c.name;
      continue;
    }
    stops.push({ id: c.id, name: c.name ?? '', lat: c.lat, lon: c.lon, s: pr.s, side });
    prevS = pr.s;
  }
  // Many routes (especially buses) are mapped as a path without stops: space
  // halts evenly along the line so they can still be driven.
  let synthStops = false;
  if (stops.length < 2 && path.length > 600) {
    synthStops = true;
    const road = ref.mode === 'bus' || ref.mode === 'trolleybus';
    const spacing = road ? 650 : ref.mode === 'tram' || ref.mode === 'light_rail' ? 600 : ref.mode === 'ferry' ? 2500 : 1300;
    const n = Math.max(2, Math.min(30, Math.round(path.length / spacing) + 1));
    const s0 = Math.min(30, path.length * 0.02);
    const s1 = path.length - Math.min(30, path.length * 0.02);
    stops.length = 0;
    for (let i = 0; i < n; i++) {
      const sAt = s0 + ((s1 - s0) * i) / (n - 1);
      const [la, lo] = path.pointAt(sAt);
      const name = i === 0 ? (ref.from ?? 'Start') : i === n - 1 ? (ref.to ?? 'Terminus') : `Halt ${i}`;
      stops.push({ id: `synth${i}`, name, lat: la, lon: lo, s: sAt, side: driveSide });
    }
  }
  stops.forEach((s, i) => {
    if (!s.name) s.name = `Stop ${i + 1}`;
  });
  if (stops.length < 2) throw new Error('This route has fewer than two mapped stops, so it can’t be driven yet.');

  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of clean) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }

  const colour = normalizeColour(rt.colour) ?? line.colour;
  return {
    id: ref.id,
    mode: ref.mode,
    ref: line.ref,
    name: line.name.startsWith('Unnamed ') ? `${stops[0].name} – ${stops[stops.length - 1].name}` : line.name,
    from: ref.from ?? stops[0].name,
    to: ref.to ?? stops[stops.length - 1].name,
    network: ref.network,
    colour,
    textColour: readableText(colour),
    lat: Array.from(path.lat),
    lon: Array.from(path.lon),
    stops,
    ways,
    approx,
    synthStops,
    driveSide,
    bounds: [w, s, e, n],
    fetchedAt: Date.now(),
  };
}
