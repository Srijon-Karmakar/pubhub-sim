import type { Map as MlMap } from 'maplibre-gl';
import { hexToRgb, mixHex } from '../lib/color';

/**
 * Procedural noise textures for the 3D map: asphalt, concrete, grass and forest.
 * Each exists in a day and a night ('-n') variant; the style swaps between them, so images are never
 * rewritten while driving (that caused tile reloads and flicker).
 */

type Rgb = [number, number, number];

const PR = 2;

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const rgbCss = (c: Rgb, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function noisy(size: number, base: Rgb, amp: number, seed: number, extra?: (g: CanvasRenderingContext2D, r: () => number) => void): ImageData {
  const c = canvas(size, size);
  const g = c.getContext('2d')!;
  const r = rng(seed);
  g.fillStyle = rgbCss(base);
  g.fillRect(0, 0, size, size);
  extra?.(g, r);
  const id = g.getImageData(0, 0, size, size);
  const d = id.data;
  for (let i = 0; i < size * size; i++) {
    const n = (r() - 0.5) * amp;
    d[i * 4] += n;
    d[i * 4 + 1] += n;
    d[i * 4 + 2] += n;
  }
  return id;
}

function asphalt(base: string, seed: number, concrete: boolean): ImageData {
  const b = hexToRgb(base);
  return noisy(64, b, concrete ? 14 : 30, seed, (g, r) => {
    // aggregate chips and faint seams, kept off the edges so the tile wraps cleanly
    for (let i = 0; i < 90; i++) {
      const v = r() > 0.5 ? 255 : 0;
      g.fillStyle = `rgba(${v},${v},${v},${0.05 + r() * 0.1})`;
      g.fillRect(2 + r() * 58, 2 + r() * 58, 1 + r() * 2, 1 + r() * 2);
    }
    if (!concrete) {
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(6 + r() * 10, 6);
      g.lineTo(20 + r() * 20, 30);
      g.lineTo(10 + r() * 40, 58);
      g.stroke();
    } else {
      g.fillStyle = 'rgba(0,0,0,0.14)';
      g.fillRect(0, 31, 64, 1);
      g.fillRect(31, 0, 1, 64);
    }
  });
}

function grass(base: string, seed: number): ImageData {
  const b = hexToRgb(base);
  return noisy(96, b, 18, seed, (g, r) => {
    for (let i = 0; i < 520; i++) {
      const x = 3 + r() * 90;
      const y = 5 + r() * 88;
      const dark = r() > 0.5;
      g.strokeStyle = dark ? `rgba(20,50,20,${0.12 + r() * 0.14})` : `rgba(255,255,210,${0.07 + r() * 0.1})`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 3, y - 2 - r() * 3);
      g.stroke();
    }
  });
}

function forest(base: string, seed: number): ImageData {
  const b = hexToRgb(base);
  return noisy(96, b, 14, seed, (g, r) => {
    for (let i = 0; i < 70; i++) {
      const rad = 4 + r() * 7;
      const x = rad + r() * (96 - rad * 2);
      const y = rad + r() * (96 - rad * 2);
      const gr = g.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,220,0.2)');
      gr.addColorStop(0.7, 'rgba(0,0,0,0.04)');
      gr.addColorStop(1, 'rgba(0,10,0,0.3)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
  });
}

function add(map: MlMap, id: string, make: () => ImageData) {
  if (!map.hasImage(id)) map.addImage(id, make(), { pixelRatio: PR });
}

const NIGHT_TINT = '#0b1020';

export function ensureTextures(map: MlMap) {
  const defs: [string, string, (base: string, seed: number) => ImageData, number][] = [
    ['rd-asphalt', '#5b5f67', (b, sd) => asphalt(b, sd, false), 11],
    ['rd-concrete', '#9a978f', (b, sd) => asphalt(b, sd, true), 12],
    ['rd-service', '#6a6e75', (b, sd) => asphalt(b, sd, false), 13],
    ['tx-grass', '#a8c88d', grass, 21],
    ['tx-park', '#9cc686', grass, 22],
    ['tx-wood', '#7fae6e', forest, 23],
  ];
  for (const [id, base, make, seed] of defs) {
    add(map, id, () => make(base, seed));
    add(map, `${id}-n`, () => make(mixHex(base, NIGHT_TINT, 0.78), seed));
  }
}
