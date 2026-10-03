import type { City } from '../../types';
import { fetchJson } from './http';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_type: string;
    osm_id: number;
    osm_key: string;
    osm_value: string;
    type?: string;
    name?: string;
    state?: string;
    county?: string;
    country?: string;
    countrycode?: string;
    extent?: [number, number, number, number];
  };
}

const PLACE_OK = new Set(['city', 'town', 'municipality', 'borough', 'suburb', 'village', 'administrative', 'quarter']);

/** Keeps the query area sane: tiny extents grow, huge ones (e.g. Tokyo-to incl. islands) shrink. */
export function sizeBbox(lat: number, lon: number, ext?: [number, number, number, number]): City['bbox'] {
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const maxLat = 0.42;
  const maxLon = 0.42 / cos;
  const minLat = 0.12;
  const minLon = 0.12 / cos;
  let w = lon - minLon / 2;
  let e = lon + minLon / 2;
  let s = lat - minLat / 2;
  let n = lat + minLat / 2;
  if (ext) {
    // Photon extent: [minLon, maxLat, maxLon, minLat]
    w = Math.min(w, ext[0]);
    e = Math.max(e, ext[2]);
    n = Math.max(n, ext[1]);
    s = Math.min(s, ext[3]);
  }
  if (e - w > maxLon) {
    w = lon - maxLon / 2;
    e = lon + maxLon / 2;
  }
  if (n - s > maxLat) {
    s = lat - maxLat / 2;
    n = lat + maxLat / 2;
  }
  return [w, s, e, n];
}

function featureToCity(f: PhotonFeature): City | null {
  const p = f.properties;
  if (!p.name) return null;
  const [lon, lat] = f.geometry.coordinates;
  return {
    id: `${p.osm_type}${p.osm_id}`,
    name: p.name,
    region: p.state && p.state !== p.name ? p.state : p.county,
    country: p.country,
    countryCode: p.countrycode?.toUpperCase(),
    lat,
    lon,
    bbox: sizeBbox(lat, lon, p.extent),
  };
}

export async function searchCities(q: string, signal?: AbortSignal): Promise<City[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&layer=city&layer=district&lang=en`;
  const res = await fetchJson<{ features: PhotonFeature[] }>(url, { signal }, 10000);
  const seen = new Set<string>();
  const out: City[] = [];
  for (const f of res.features) {
    if (!PLACE_OK.has(f.properties.osm_value) && f.properties.osm_key !== 'place') continue;
    const c = featureToCity(f);
    if (!c) continue;
    const k = `${c.name}|${c.region}|${c.country}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.slice(0, 8);
}

export async function reverseCity(lat: number, lon: number): Promise<City> {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&layer=city&lang=en&limit=1`;
    const res = await fetchJson<{ features: PhotonFeature[] }>(url, {}, 10000);
    const c = res.features[0] && featureToCity(res.features[0]);
    if (c) return { ...c, lat, lon, bbox: sizeBbox(lat, lon) };
  } catch {
    /* fall through */
  }
  return { id: `geo${lat.toFixed(3)},${lon.toFixed(3)}`, name: 'Near me', lat, lon, bbox: sizeBbox(lat, lon) };
}

export const POPULAR: { name: string; country: string; cc: string; lat: number; lon: number }[] = [
  { name: 'Tokyo', country: 'Japan', cc: 'JP', lat: 35.6812, lon: 139.7671 },
  { name: 'London', country: 'United Kingdom', cc: 'GB', lat: 51.5074, lon: -0.1278 },
  { name: 'New York', country: 'United States', cc: 'US', lat: 40.7128, lon: -74.006 },
  { name: 'Paris', country: 'France', cc: 'FR', lat: 48.8566, lon: 2.3522 },
  { name: 'Kolkata', country: 'India', cc: 'IN', lat: 22.5726, lon: 88.3639 },
  { name: 'Berlin', country: 'Germany', cc: 'DE', lat: 52.52, lon: 13.405 },
  { name: 'Singapore', country: 'Singapore', cc: 'SG', lat: 1.2966, lon: 103.8521 },
  { name: 'Istanbul', country: 'Türkiye', cc: 'TR', lat: 41.0082, lon: 28.9784 },
  { name: 'Hong Kong', country: 'China', cc: 'HK', lat: 22.2988, lon: 114.1722 },
  { name: 'Melbourne', country: 'Australia', cc: 'AU', lat: -37.8136, lon: 144.9631 },
  { name: 'Mumbai', country: 'India', cc: 'IN', lat: 19.076, lon: 72.8777 },
  { name: 'Zürich', country: 'Switzerland', cc: 'CH', lat: 47.3769, lon: 8.5417 },
];

export function popularToCity(p: (typeof POPULAR)[number]): City {
  return {
    id: `pop-${p.name}`,
    name: p.name,
    country: p.country,
    countryCode: p.cc,
    lat: p.lat,
    lon: p.lon,
    bbox: sizeBbox(p.lat, p.lon, [p.lon - 0.16, p.lat + 0.13, p.lon + 0.16, p.lat - 0.13]),
  };
}

export function flagEmoji(cc?: string): string {
  if (!cc || cc.length !== 2) return '🌐';
  return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Countries driving on the left. Used for bus lane offset and default platform side. */
const LEFT = new Set(
  'GB IE IN JP AU NZ ZA HK MO SG MY TH ID PK BD LK NP BT KE UG TZ ZM ZW MW MZ BW NA LS SZ MU CY MT JM TT BB BS GY SR FJ PG BN TL KY BM VG MV'.split(' '),
);
export function driveSideFor(cc?: string): -1 | 1 {
  return cc && LEFT.has(cc.toUpperCase()) ? -1 : 1;
}
