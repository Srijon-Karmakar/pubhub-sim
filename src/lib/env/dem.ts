import type { RouteData } from '../../types';
import { RoutePath } from '../geo';
import { cacheGet, cacheSet, DAY } from '../osm/cache';
import { flattenDem, TILE, tileMpp } from './demFlat';

/**
 * Terrain elevation from the open AWS Terrarium tiles — the same source the map
 * renders its 3D terrain from (at the same zoom), so the track sits on the ground
 * the player sees.
 */
export const DEM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
export const DEM_ZOOM = 13;
/** the map reads terrain through this protocol (see flatTile) so plains render flat */
export const DEM_FLAT_URL = 'flatdem://{z}/{x}/{y}';
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
        const viaWorker = ask('heights', z, x, y);
        if (viaWorker) {
          try {
            const r = await viaWorker;
            if (r.heights) return r.heights;
          } catch {
            // fall through to the main thread
          }
        }
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
        return flattenDem(out, tileMpp(z, y));
      } catch {
        tiles.delete(key);
        return null;
      }
    })();
    tiles.set(key, p);
  }
  return p;
}

type WorkerReply = { id: number; heights?: Float32Array; image?: ImageBitmap; error?: string };
let worker: Worker | null | undefined;
let reqId = 0;
const waiting = new Map<number, { ok: (r: WorkerReply) => void; fail: (e: Error) => void }>();

/** terrain decoding and smoothing run off the main thread so loading a route doesn't stutter the page */
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    const w = new Worker(new URL('./demWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const q = waiting.get(e.data.id);
      if (!q) return;
      waiting.delete(e.data.id);
      if (e.data.error) q.fail(new Error(e.data.error));
      else q.ok(e.data);
    };
    w.onerror = () => {
      // fall back to the main thread for everything from now on
      worker = null;
      for (const q of waiting.values()) q.fail(new Error('terrain worker failed'));
      waiting.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function ask(mode: 'heights' | 'image', z: number, x: number, y: number): Promise<WorkerReply> | null {
  const w = getWorker();
  if (!w) return null;
  return new Promise((ok, fail) => {
    const id = ++reqId;
    waiting.set(id, { ok, fail });
    w.postMessage({ id, mode, z, x, y, url: tileUrl(z, x, y) });
  });
}

const flatCache = new Map<string, Promise<ImageBitmap>>();

/** Terrarium tile with plains flattened, handed to the map as a decoded image */
export function flatTile(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const m = /(\d+)\/(\d+)\/(\d+)\s*$/.exec(url);
  if (!m) return Promise.reject(new Error('bad terrain tile url'));
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const key = `${z}/${x}/${y}`;
  let p = flatCache.get(key);
  if (!p) {
    p = (async () => {
      const viaWorker = ask('image', z, x, y);
      if (viaWorker) {
        try {
          const r = await viaWorker;
          if (r.image) return r.image;
        } catch {
          // fall through to the main thread
        }
      }
      const res = await fetch(tileUrl(z, x, y), { signal });
      if (!res.ok) throw new Error(`terrain tile ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const cv = document.createElement('canvas');
      cv.width = TILE;
      cv.height = TILE;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, TILE, TILE);
      const px = img.data;
      const h = new Float32Array(TILE * TILE);
      for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      const f = flattenDem(h, tileMpp(z, y));
      for (let i = 0; i < f.length; i++) {
        const v = Math.min(65535.99, Math.max(0, f[i] + 32768));
        const whole = Math.floor(v);
        px[i * 4] = whole >> 8;
        px[i * 4 + 1] = whole & 255;
        px[i * 4 + 2] = Math.floor((v - whole) * 256);
        px[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return createImageBitmap(cv, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    })();
    flatCache.set(key, p);
    p.catch(() => flatCache.delete(key));
    if (flatCache.size > 160) flatCache.delete(flatCache.keys().next().value as string);
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
  const key = `ground:v2:${route.id}`;
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
