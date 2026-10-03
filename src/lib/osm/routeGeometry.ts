import type { Line, RouteData, RouteRef, Stop, WaySpan } from '../../types';
import { normalizeColour, readableText } from '../color';
import { haversine, RoutePath, toENU } from '../geo';
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
  const res = await fetchJson<{ elements: OsmApiElement[] }>(`https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`, { signal }, 15000);
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
    ...res.elements.filter((e) => e.type !== 'relation' && e.tags).map((e) => ({ type: e.type, id: e.id, tags: e.tags })),
  ];
}

export async function fetchRoute(
  ref: RouteRef,
  line: Line,
  driveSide: -1 | 1,
  signal?: AbortSignal,
  onAttempt?: (host: string) => void,
): Promise<RouteData> {
  const key = `route:v4:${ref.id}`;
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
out tags;`;
    elements = (await overpass(q, { timeoutMs: 35000, staggerMs: 4000, signal, onAttempt: (h) => onAttempt?.(h) })).elements;
  }
  const data = await parseRoute(elements, ref, line, driveSide);
  await cacheSet(key, data);
  return data;
}

export async function parseRoute(
  elements: OverpassElement[],
  ref: RouteRef,
  line: Line,
  driveSide: -1 | 1,
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
