/** Pure terrain helpers, shared by the main thread and the terrain worker. */
export const TILE = 256;

/** metres per pixel of a 256 px tile row */
export function tileMpp(z: number, y: number) {
  const n = 2 ** z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  return (156543.03392 * Math.cos(lat)) / n;
}

/** separable box blur with clamped edges, in place on a scratch copy */
function blur(src: Float32Array, r: number): Float32Array {
  const n = TILE;
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * n + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc / w;
      acc += src[y * n + Math.min(n - 1, x + r + 1)] - src[y * n + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc / w;
      acc += tmp[Math.min(n - 1, y + r + 1) * n + x] - tmp[Math.max(0, y - r) * n + x];
    }
  }
  return out;
}

/**
 * Satellite-derived elevation is noisy: a few metres of ripple on flat delta land, trees and buildings baked in.
 * Where the ground is genuinely sloped (hills, mountains) the tile is left as it was; where it is nearly flat
 * the heights are smoothed hard and compressed so plains render as plains. Every step is local, so tiles agree at their edges.
 */
export function flattenDem(h: Float32Array, mpp: number): Float32Array {
  const detail = blur(h, 1);
  const wide = blur(blur(h, 6), 6);
  const broad = blur(blur(h, 14), 14);
  // slope of the smoothed surface decides how hilly the place is
  const grade = new Float32Array(TILE * TILE);
  const d = 6;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const xa = Math.min(TILE - 1, x + d);
      const xb = Math.max(0, x - d);
      const ya = Math.min(TILE - 1, y + d);
      const yb = Math.max(0, y - d);
      const gx = (wide[y * TILE + xa] - wide[y * TILE + xb]) / ((xa - xb) * mpp || 1);
      const gy = (wide[ya * TILE + x] - wide[yb * TILE + x]) / ((ya - yb) * mpp || 1);
      grade[y * TILE + x] = Math.hypot(gx, gy);
    }
  }
  const slope = blur(blur(grade, 10), 10);
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < out.length; i++) {
    const t = Math.min(1, Math.max(0, (slope[i] - 0.012) / 0.05));
    const f = t * t * (3 - 2 * t);
    const plain = broad[i] + (wide[i] - broad[i]) * 0.3;
    out[i] = plain + (detail[i] - plain) * f;
  }
  return out;
}
