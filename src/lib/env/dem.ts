import type { RouteData } from '../../types';
import { RoutePath } from '../geo';
import { cacheGet, cacheSet, DAY } from '../osm/cache';

/**
 * Terrain elevation from the open AWS Terrarium tiles — the same source the map
 * renders its 3D terrain from (at the same zoom), so the track sits on the ground
 * the player sees.
 */
export const DEM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
export const DEM_ZOOM = 13;
const TILE = 256;
export const GROUND_STEP = 10;

const tiles = new Map<string, Promise<Float32Array | null>>();

function tileUrl(z: number, x: number, y: number) {
  return DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

async function loadTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = tiles.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(tileUrl(z, x, y), { signal });
        if (!res.ok) return null;
        const bmp = await createImageBitmap(await res.blob());
        const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
        const ctx = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!ctx) return null;
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, TILE, TILE).data;
        const out = new Float32Array(TILE * TILE);
        // Terrarium encoding: (R * 256 + G + B / 256) - 32768
        for (let i = 0; i < TILE * TILE; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        return out;
      } catch {
        tiles.delete(key);
        return null;
      }
    })();
    tiles.set(key, p);
  }
  return p;
}

function project(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Ground height (m) along the route every GROUND_STEP metres; null when terrain can't be loaded. */
export async function loadGroundProfile(route: RouteData, signal?: AbortSignal): Promise<RouteData['ground'] | null> {
  if (typeof createImageBitmap === 'undefined') return null;
  const key = `ground:v1:${route.id}`;
  const cached = await cacheGet<RouteData['ground']>(key, 90 * DAY);
  if (cached) return cached;
  const path = new RoutePath(route.lat, route.lon);
  const n = Math.max(2, Math.ceil(path.length / GROUND_STEP) + 1);
  if (n > 60000) return null; // absurdly long relation: skip terrain
  const z = DEM_ZOOM;
  const pts: { tx: number; ty: number; px: number; py: number }[] = [];
  const need = new Set<string>();
  for (let i = 0; i < n; i++) {
    const [la, lo] = path.pointAt(Math.min(i * GROUND_STEP, path.length));
    const { x, y } = project(la, lo, z);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    pts.push({ tx, ty, px: (x - tx) * TILE, py: (y - ty) * TILE });
    need.add(`${tx}/${ty}`);
  }
  if (need.size > 400) return null;
  const loaded = new Map<string, Float32Array | null>();
  await Promise.all(
    [...need].map(async (k) => {
      const [tx, ty] = k.split('/').map(Number);
      loaded.set(k, await loadTile(z, tx, ty, signal));
    }),
  );
  const zs = new Array<number>(n);
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const t = loaded.get(`${p.tx}/${p.ty}`);
    if (!t) {
      zs[i] = NaN;
      missing++;
      continue;
    }
    // bilinear sample (clamped at tile edges)
    const x0 = Math.min(TILE - 2, Math.max(0, Math.floor(p.px - 0.5)));
    const y0 = Math.min(TILE - 2, Math.max(0, Math.floor(p.py - 0.5)));
    const fx = Math.min(1, Math.max(0, p.px - 0.5 - x0));
    const fy = Math.min(1, Math.max(0, p.py - 0.5 - y0));
    const a = t[y0 * TILE + x0];
    const b = t[y0 * TILE + x0 + 1];
    const c = t[(y0 + 1) * TILE + x0];
    const d = t[(y0 + 1) * TILE + x0 + 1];
    zs[i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  if (missing > n * 0.2) return null;
  // fill gaps from neighbours
  let last = zs.find((v) => !isNaN(v)) ?? 0;
  for (let i = 0; i < n; i++) {
    if (isNaN(zs[i])) zs[i] = last;
    else last = zs[i];
  }
  const ground = { step: GROUND_STEP, z: zs.map((v) => Math.round(v * 10) / 10) };
  await cacheSet(key, ground);
  return ground;
}
