import type { City, Line, Mode, RouteRef } from '../../types';
import { normalizeColour, readableText } from '../color';
import { GROUP_COLOUR, MODE_GROUP, MODE_ORDER } from '../sim/profiles';
import { cacheGet, cacheSet, DAY } from './cache';
import { overpass } from './http';

const MODES: Mode[] = ['bus', 'trolleybus', 'subway', 'train', 'light_rail', 'tram', 'monorail', 'ferry'];

export interface CityRoutesProgress {
  stage: 'cache' | 'query' | 'parse';
  host?: string;
  attempt?: number;
}

const HIGHWAYS =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|busway|bus_guideway|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

/**
 * Finding routes through their member ways (rails / roads) is ~10x cheaper for
 * Overpass than `rel(bbox)`, which has to walk back up from every node.
 */
function queryFor(kind: 'rail' | 'bus', bbox: City['bbox']): string {
  const [w, s, e, n] = bbox;
  const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  if (kind === 'rail') {
    return `[out:json][timeout:60][bbox:${bb}];
(way[railway~"^(rail|subway|light_rail|tram|monorail|narrow_gauge|funicular|preserved)$"];way[route=ferry];)->.r;
rel(bw.r)[type=route][route~"^(subway|train|light_rail|tram|monorail|ferry)$"];
out tags;`;
  }
  return `[out:json][timeout:90][bbox:${bb}];
way[highway~"^(${HIGHWAYS})$"]->.h;
rel(bw.h)[type=route][route~"^(bus|trolleybus)$"];
out tags;`;
}

const COACH = /\b(flix\w*|eurolines|blablabus|megabus|greyhound|ouibus|regiojet|fernbus|alsa)\b/i;
const LONG_RAIL = /\b(ICE|IC|EC|TGV|Eurostar|Thalys|AVE|Frecciarossa|Railjet|Nightjet|Shinkansen|Rajdhani|Shatabdi|Duronto|Vande Bharat|Amtrak|Intercity|InterCity|EuroCity)\b/;

function toRefs(elements: { id: number; tags?: Record<string, string> }[]): RouteRef[] {
  const refs: RouteRef[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const mode = t.route as Mode;
    if (!MODES.includes(mode)) continue;
    if (t.disused === 'yes' || t['disused:route'] || t.state === 'proposed') continue;
    const blob = `${t.name ?? ''} ${t.network ?? ''} ${t.operator ?? ''} ${t.brand ?? ''}`;
    const ld = t.service === 'long_distance' || t.service === 'night' || t.bus === 'coach' || t.coach === 'yes';
    // intercity coaches are not city transit
    if ((mode === 'bus' || mode === 'trolleybus') && (ld || COACH.test(blob))) continue;
    const longDistance = mode === 'train' && (ld || t.service === 'high_speed' || LONG_RAIL.test(blob));
    refs.push({
      id: el.id,
      mode,
      ref: t.ref?.trim() || undefined,
      name: (t['name:en'] || t.name)?.trim() || undefined,
      from: (t['from:en'] || t.from)?.trim() || undefined,
      to: (t['to:en'] || t.to)?.trim() || undefined,
      via: t.via,
      colour: t.colour || t['colour:line'],
      network: t.network,
      operator: t.operator,
      longDistance: longDistance || undefined,
    });
  }
  return refs;
}

export async function fetchRoutesKind(
  kind: 'rail' | 'bus',
  city: City,
  onProgress?: (p: CityRoutesProgress) => void,
  signal?: AbortSignal,
  force = false,
): Promise<RouteRef[]> {
  const key = `routes:v5:${kind}:${city.bbox.map((v) => v.toFixed(3)).join(',')}`;
  if (!force) {
    onProgress?.({ stage: 'cache' });
    const cached = await cacheGet<RouteRef[]>(key, 7 * DAY);
    if (cached) return cached;
  }
  onProgress?.({ stage: 'query' });
  const res = await overpass(queryFor(kind, city.bbox), {
    timeoutMs: kind === 'rail' ? 45000 : 75000,
    signal,
    onAttempt: (host, attempt) => onProgress?.({ stage: 'query', host, attempt }),
  });
  onProgress?.({ stage: 'parse' });
  const refs = toRefs(res.elements);
  await cacheSet(key, refs);
  return refs;
}

/** "Blue Line (Kavi Subhash → Dakshineshwar)" → "Blue Line" */
export function cleanLineName(name?: string): string {
  if (!name) return '';
  return name
    .replace(/\s*[([].*?(→|->|=>|⇒|–|—|-|\bto\b).*?[)\]]\s*/gi, ' ')
    .replace(/\s*:\s*.*?(→|->|=>|⇒).*$/i, '')
    .replace(/\s+(→|->|=>|⇒).*$/i, '')
    .trim();
}

function shortRef(r: RouteRef): string {
  if (r.ref) return r.ref.length > 8 ? r.ref.slice(0, 8) : r.ref;
  const n = cleanLineName(r.name);
  const m = n.match(/^([A-Za-z]+)\s+(line|linie|ligne|línea|linea)/i);
  if (m) return m[1].slice(0, 6);
  const num = n.match(/\b([A-Z]?\d{1,4}[A-Z]?)\b/);
  if (num) return num[1];
  // no ref and no usable name: the badge shows the mode icon instead
  return '';
}

const PROFILES_LABEL: Record<Mode, string> = {
  subway: 'metro',
  train: 'train',
  light_rail: 'light rail',
  tram: 'tram',
  monorail: 'monorail',
  bus: 'bus',
  trolleybus: 'trolleybus',
  ferry: 'ferry',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function groupLines(refs: RouteRef[]): Line[] {
  const map = new Map<string, Line>();
  // routes with a ref first, so ref-less siblings can join them by name
  const sorted = [...refs].sort((a, b) => (a.ref ? 0 : 1) - (b.ref ? 0 : 1));
  const byName = new Map<string, string>();
  for (const r of sorted) {
    if (!r.ref) {
      const nm = cleanLineName(r.name).toLowerCase();
      const k = byName.get(`${MODE_GROUP[r.mode]}|${nm}|${(r.network || '').toLowerCase()}`);
      const target = k ? map.get(k) : undefined;
      if (target && nm) {
        target.variants.push(r);
        continue;
      }
    }
    const group = MODE_GROUP[r.mode];
    const id = (r.ref || cleanLineName(r.name) || String(r.id)).toLowerCase();
    const key = `${group}|${id}|${(r.network || '').toLowerCase()}`;
    let line = map.get(key);
    if (!line) {
      const colour = normalizeColour(r.colour) ?? GROUP_COLOUR[group];
      line = {
        key,
        mode: r.mode,
        group,
        ref: shortRef(r),
        name: cleanLineName(r.name) || (r.from && r.to ? `${r.from} – ${r.to}` : r.ref ? `${r.ref}` : `Unnamed ${PROFILES_LABEL[r.mode]} line`),
        colour,
        textColour: readableText(colour),
        network: r.network,
        longDistance: r.longDistance,
        variants: [],
      };
      map.set(key, line);
      const nm = cleanLineName(r.name).toLowerCase();
      if (nm) byName.set(`${group}|${nm}|${(r.network || '').toLowerCase()}`, key);
    }
    line.variants.push(r);
  }
  const lines = [...map.values()];
  for (const l of lines) {
    l.variants.sort((a, b) => collator.compare(a.name ?? '', b.name ?? ''));
  }
  lines.sort((a, b) => {
    const ma = MODE_ORDER.indexOf(a.mode);
    const mb = MODE_ORDER.indexOf(b.mode);
    if (ma !== mb) return ma - mb;
    if (!!a.longDistance !== !!b.longDistance) return a.longDistance ? 1 : -1;
    return collator.compare(a.ref, b.ref);
  });
  return lines;
}

export function variantLabel(r: RouteRef): string {
  if (r.to) return r.from ? `${r.from} → ${r.to}` : `to ${r.to}`;
  const m = r.name?.match(/[:(]\s*(.+?)\s*(→|->|=>|⇒|–|—)\s*(.+?)\s*\)?$/);
  if (m) return `${m[1]} → ${m[3]}`;
  return r.name ?? `Route ${r.id}`;
}
