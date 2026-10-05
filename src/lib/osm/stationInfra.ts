import type { RouteData, StationInfra } from '../../types';
import { RoutePath, toENU } from '../geo';
import { cacheGet, cacheSet, DAY } from './cache';
import { overpass } from './http';

const MAX_STOPS = 60;
const CHUNK = 14;

/**
 * Real platforms and neighbouring tracks around every station on a rail route,
 * so big termini (Howrah, Sealdah, Shinjuku, Grand Central…) show all their
 * platforms instead of only the one the route uses. Loaded in the background.
 */
export async function fetchStationInfra(route: RouteData, signal?: AbortSignal): Promise<StationInfra | null> {
  const key = `infra:v1:${route.id}`;
  const cached = await cacheGet<StationInfra>(key, 30 * DAY);
  if (cached) return cached;

  const stops = route.stops.filter((s) => !s.id.startsWith('synth'));
  if (!stops.length) return null;
  const pick = stops.length <= MAX_STOPS ? stops : stops.filter((_, i) => i % Math.ceil(stops.length / MAX_STOPS) === 0);
  const tram = route.mode === 'tram' || route.mode === 'light_rail';
  const platformR = tram ? 80 : 240;
  const trackR = tram ? 0 : 170;

  const platforms: StationInfra['platforms'] = [];
  const tracks: StationInfra['tracks'] = [];
  const seen = new Set<number>();
  const path = new RoutePath(route.lat, route.lon);

  for (let i = 0; i < pick.length; i += CHUNK) {
    const group = pick.slice(i, i + CHUNK);
    const parts: string[] = [];
    for (const s of group) {
      const c = `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
      parts.push(`way(around:${platformR},${c})[railway=platform];`);
      parts.push(`way(around:${platformR},${c})[public_transport=platform][railway!=platform][highway!=bus_stop][highway!=platform];`);
      if (trackR) parts.push(`way(around:${trackR},${c})[railway~"^(rail|subway|light_rail)$"][service!~"^(siding|yard|spur|crossover)$"];`);
    }
    const q = `[out:json][timeout:40];(${parts.join('')});out geom;`;
    let res;
    try {
      res = await overpass(q, { timeoutMs: 40000, staggerMs: 5000, signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      continue;
    }
    for (const el of res.elements) {
      if (el.type !== 'way' || !el.geometry || seen.has(el.id)) continue;
      seen.add(el.id);
      const pts = el.geometry.filter((p): p is { lat: number; lon: number } => !!p).map((p) => [p.lat, p.lon] as [number, number]);
      if (pts.length < 2) continue;
      const t = el.tags ?? {};
      if (t.railway === 'platform' || t.public_transport === 'platform') {
        const area = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
        platforms.push({ pts, area });
      } else {
        // skip the route's own track: it is already drawn
        let near = 0;
        const n = Math.min(8, pts.length);
        for (let k = 0; k < n; k++) {
          const p = pts[Math.floor((k * (pts.length - 1)) / Math.max(1, n - 1))];
          if (path.project(p[0], p[1]).d < 3) near++;
        }
        if (near / n > 0.6) continue;
        tracks.push(clipNear(pts, group));
      }
    }
  }
  const infra: StationInfra = { platforms, tracks: tracks.filter((t) => t.length >= 2) };
  await cacheSet(key, infra);
  return infra;
}

/** Long track ways are trimmed to the part around stations. */
function clipNear(pts: [number, number][], stops: { lat: number; lon: number }[]): [number, number][] {
  return pts.filter((p) =>
    stops.some((s) => {
      const [x, y] = toENU(p[0], p[1], s.lat, s.lon);
      return x * x + y * y < 600 * 600;
    }),
  );
}
