import { useEffect, useRef } from 'react';
import { LOW_END } from '../lib/device';
import { mapCtl } from '../map/mapController';

type RGB = [number, number, number];
type Cv = HTMLCanvasElement;

interface Look {
  skyTop: RGB;
  skyLow: RGB;
  ground: RGB;
  rail: RGB;
  night: boolean;
}

const DAY: Look = { skyTop: [92, 146, 210], skyLow: [208, 226, 240], ground: [112, 124, 104], rail: [226, 230, 236], night: false };
const NIGHT: Look = { skyTop: [4, 8, 20], skyLow: [34, 42, 82], ground: [14, 18, 26], rail: [150, 162, 186], night: true };

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function hash(i: number, salt: number) {
  let h = Math.imul(i | 0, 374761393) + Math.imul(salt | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
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

function canvas(w: number, h: number): Cv {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctxOf(c: Cv) {
  return c.getContext('2d') as CanvasRenderingContext2D;
}

/** copy of a sprite darkened/tinted, keeping its alpha */
function tinted(src: Cv, color: string): Cv {
  const c = canvas(src.width, src.height);
  const g = ctxOf(c);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** per-pixel monochrome film grain with alpha, used as an overlay pattern */
function grainTile(size: number, amp: number, seed: number): Cv {
  const c = canvas(size, size);
  const g = ctxOf(c);
  const id = g.createImageData(size, size);
  const r = rng(seed);
  for (let i = 0; i < size * size; i++) {
    const v = r() > 0.5 ? 255 : 0;
    id.data[i * 4] = v;
    id.data[i * 4 + 1] = v;
    id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = r() * amp * 255;
  }
  g.putImageData(id, 0, 0);
  return c;
}

// ---------------------------------------------------------------- ground atlas (32 m x 32 m, X -16..16)
const GROUND_M = 32;

function buildGround(): Cv[] {
  const S = LOW_END ? 512 : 1024;
  const ppm = S / GROUND_M;
  const c = canvas(S, S);
  const g = ctxOf(c);
  const r = rng(90210);
  const X = (m: number) => (m + 16) * ppm;
  const rect = (x0: number, x1: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(X(x0), 0, X(x1) - X(x0), S);
  };

  rect(-16, 16, '#68745c');
  rect(-5.4, 5.4, '#7a766a');
  rect(-14.2, -5.4, '#54575f');
  rect(5.4, 14.2, '#54575f');
  rect(-14.4, -14.2, '#9a978e');
  rect(14.2, 14.4, '#9a978e');
  rect(-16, -14.4, '#a8a59a');
  rect(14.4, 16, '#a8a59a');
  rect(-2.7, 2.7, '#5c5852');

  // large soft blotches break up flat colour
  for (let i = 0; i < 150; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 30 + r() * 90;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    const light = r() > 0.5;
    gr.addColorStop(0, light ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  // per-pixel grain, stronger on stone and gravel than on tarmac
  const id = g.getImageData(0, 0, S, S);
  const d = id.data;
  for (let x = 0; x < S; x++) {
    const m = Math.abs(x / ppm - 16);
    const amp = m < 2.7 ? 46 : m < 5.4 ? 34 : m < 14.2 ? 22 : 16;
    for (let y = 0; y < S; y++) {
      const n = (r() - 0.5) * amp;
      const k = (y * S + x) * 4;
      d[k] += n;
      d[k + 1] += n;
      d[k + 2] += n;
    }
  }
  g.putImageData(id, 0, 0);

  // verge grass tufts and dirt
  for (let i = 0; i < 1400; i++) {
    const side = r() > 0.5 ? 1 : -1;
    const x = X(side * (2.9 + r() * 2.4));
    const y = r() * S;
    g.strokeStyle = `rgba(${60 + r() * 40},${90 + r() * 50},${50 + r() * 30},0.8)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (r() - 0.5) * 5, y - 3 - r() * 6);
    g.stroke();
  }

  // ballast stones
  for (let i = 0; i < 9000; i++) {
    const x = X(-2.7 + r() * 5.4);
    const y = r() * S;
    const rw = 1.2 + r() * 3.2;
    const rh = rw * (0.6 + r() * 0.5);
    const v = 70 + r() * 90;
    g.fillStyle = `rgba(0,0,0,0.35)`;
    g.beginPath();
    g.ellipse(x + 1, y + 1, rw, rh, r() * 3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
    g.beginPath();
    g.ellipse(x, y, rw, rh, r() * 3, 0, Math.PI * 2);
    g.fill();
  }

  // concrete sleepers every 0.8 m
  for (let k = 0; k < GROUND_M / 0.8; k++) {
    const y = k * 0.8 * ppm;
    const sh = 0.26 * ppm;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(X(-1.52), y + 2, X(1.52) - X(-1.52), sh);
    const v = 120 + r() * 22;
    g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
    g.fillRect(X(-1.5), y, X(1.5) - X(-1.5), sh);
    g.fillStyle = 'rgba(255,255,255,0.2)';
    g.fillRect(X(-1.5), y, X(1.5) - X(-1.5), 2);
    for (let n = 0; n < 40; n++) {
      g.fillStyle = r() > 0.5 ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.15)';
      g.fillRect(X(-1.5) + r() * (X(1.5) - X(-1.5)), y + r() * sh, 2, 1);
    }
    for (const rx of [-0.72, 0.72]) {
      g.fillStyle = '#2b2a28';
      g.fillRect(X(rx) - 0.16 * ppm, y - 1, 0.32 * ppm, sh + 2);
      g.fillStyle = '#6a655c';
      g.fillRect(X(rx) - 0.05 * ppm, y + 1, 0.1 * ppm, sh - 2);
    }
  }

  for (const side of [-1, 1]) {
    // tyre wear bands
    for (const cx of [7.45, 10.05]) {
      const gr = g.createLinearGradient(X(side * cx - 0.55), 0, X(side * cx + 0.55), 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0.16)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(X(side * cx - 0.55), 0, 1.1 * ppm, S);
    }
    // patched repairs
    for (let i = 0; i < 9; i++) {
      const x = X(side * (5.8 + r() * 7.5));
      const y = r() * S;
      const pw = (0.6 + r() * 1.6) * ppm;
      const ph = (0.8 + r() * 3) * ppm;
      g.fillStyle = r() > 0.5 ? 'rgba(20,20,26,0.22)' : 'rgba(255,255,255,0.05)';
      g.fillRect(x, y, pw, ph);
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 1;
      g.strokeRect(x, y, pw, ph);
    }
    // hairline cracks
    for (let i = 0; i < 14; i++) {
      let x = X(side * (5.8 + r() * 8));
      let y = r() * S;
      g.strokeStyle = `rgba(14,14,18,${0.4 + r() * 0.3})`;
      g.lineWidth = 0.8 + r() * 1.2;
      g.beginPath();
      g.moveTo(x, y);
      const n = 8 + Math.floor(r() * 14);
      for (let j = 0; j < n; j++) {
        x += (r() - 0.5) * 16;
        y += 8 + r() * 22;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // manhole covers
    for (let i = 0; i < 2; i++) {
      const x = X(side * (6.5 + r() * 6));
      const y = r() * S;
      const rad = 0.42 * ppm;
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.beginPath();
      g.arc(x + 1, y + 1, rad + 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#3d3f44';
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1;
      for (let k = -4; k <= 4; k++) {
        g.beginPath();
        g.moveTo(x - rad * 0.8, y + k * rad * 0.2);
        g.lineTo(x + rad * 0.8, y + k * rad * 0.2);
        g.stroke();
      }
    }
    // worn centre dashes
    for (let k = 0; k < 4; k++) {
      const y = k * 8 * ppm;
      g.fillStyle = '#e6e5dc';
      g.fillRect(X(side * 8.3 - 0.09), y, 0.18 * ppm, 3.4 * ppm);
      for (let n = 0; n < 70; n++) {
        g.fillStyle = 'rgba(70,72,80,0.7)';
        g.fillRect(X(side * 8.3 - 0.09) + r() * 0.18 * ppm, y + r() * 3.4 * ppm, 2, 2);
      }
    }
    // kerb edge shading
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(X(side > 0 ? 14.2 : -14.4), 0, 0.2 * ppm, S);
    // pavement slabs
    for (let k = 0; k < 16; k++) {
      const y = k * 2 * ppm;
      g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${0.03 + r() * 0.06})`;
      g.fillRect(X(side > 0 ? 14.4 : -16), y, 1.6 * ppm, 2 * ppm);
      g.fillStyle = 'rgba(20,20,20,0.5)';
      g.fillRect(X(side > 0 ? 14.4 : -16), y, 1.6 * ppm, 2);
    }
    g.fillStyle = 'rgba(20,20,20,0.35)';
    g.fillRect(X(side > 0 ? 15.2 : -15.2), 0, 1.5, S);
  }

  const mips = [c];
  for (let size = S / 2; size >= 128; size /= 2) {
    const m = canvas(size, size);
    const mg = ctxOf(m);
    mg.imageSmoothingQuality = 'high';
    mg.drawImage(mips[mips.length - 1], 0, 0, size, size);
    mips.push(m);
  }
  return mips;
}

// ---------------------------------------------------------------- facades (4 bays x 8 floors, 13.6 m x 27.2 m)
const TW = 13.6;
const TH = 27.2;
const FW = 512;
const FH = 1024;
const BAY = 128;
const PPM_F = FW / TW;
const SHOP_H = 4.25;
const SHOP_PX = Math.round(SHOP_H * PPM_F);

export interface Facade {
  kind: number;
  albedo: Cv;
  emis: Cv | null;
  avg: RGB;
}

interface Shop {
  albedo: Cv;
  emis: Cv | null;
  color: RGB;
}

const KINDS = 10;
/** facade textures are painted at half size on phones (a quarter of the memory) */
const FSCALE = LOW_END ? 0.5 : 1;
// 0-5 general city stock; 6-9 painted colonial plaster in ochre, faded blue, dusty rose and sage
const WALL: RGB[] = [[158, 92, 74], [204, 190, 164], [96, 126, 150], [220, 216, 206], [150, 160, 172], [192, 168, 136], [222, 172, 84], [128, 170, 198], [204, 148, 146], [160, 190, 150]];
const SHUTTER: RGB[] = [[44, 98, 70], [236, 232, 220], [38, 86, 84], [120, 62, 46]];

function paintGrain(g: CanvasRenderingContext2D, w: number, h: number, grain: Cv, alpha = 1) {
  const pat = g.createPattern(grain, 'repeat');
  if (!pat) return;
  g.globalAlpha = alpha;
  g.fillStyle = pat;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
}

function buildFacade(kind: number, grain: Cv): Facade {
  const c = canvas(FW * FSCALE, FH * FSCALE);
  const g = ctxOf(c);
  g.scale(FSCALE, FSCALE);
  const r = rng(1000 + kind * 77);
  const base = WALL[kind];
  const glassKind = kind === 2 || kind === 4;

  g.fillStyle = css(base);
  g.fillRect(0, 0, FW, FH);

  if (kind === 0) {
    // brick courses with mortar and colour scatter
    g.fillStyle = '#b3a998';
    g.fillRect(0, 0, FW, FH);
    for (let y = 0, row = 0; y < FH; y += 9, row++) {
      for (let x = -(row % 2) * 11; x < FW; x += 22) {
        const v = (r() - 0.5) * 34;
        g.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.6},${base[2] + v * 0.5})`;
        g.fillRect(x + 1, y + 1, 20, 7);
      }
    }
  } else if (kind === 1 || kind === 5 || kind >= 6) {
    // stucco / sandstone: soft mottling plus fine render
    for (let i = 0; i < 260; i++) {
      const x = r() * FW;
      const y = r() * FH;
      const rad = 20 + r() * 70;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, r() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(60,40,20,0.09)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    if (kind >= 6) {
      // rising damp at the base of every floor, monsoon streaks and patches where plaster has fallen away
      for (let rr = 0; rr < 8; rr++) {
        const gy = rr * BAY + BAY;
        const gr = g.createLinearGradient(0, gy - 34, 0, gy);
        gr.addColorStop(0, 'rgba(40,36,24,0)');
        gr.addColorStop(1, 'rgba(40,36,24,0.22)');
        g.fillStyle = gr;
        g.fillRect(0, gy - 34, FW, 34);
      }
      for (let i = 0; i < 16; i++) {
        const px = r() * (FW - 60);
        const py = r() * (FH - 60);
        const pw = 18 + r() * 38;
        const ph = 14 + r() * 30;
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.beginPath();
        g.moveTo(px - 2, py - 2);
        for (let k = 1; k <= 7; k++) g.lineTo(px + (pw * k) / 7 + (r() - 0.5) * 8, py + (k % 2 ? -3 : ph * (0.7 + r() * 0.3)));
        g.lineTo(px + pw * 0.2, py + ph + 3);
        g.closePath();
        g.fill();
        g.fillStyle = `rgb(${150 + r() * 30},${84 + r() * 20},${66 + r() * 16})`;
        g.beginPath();
        g.moveTo(px, py);
        for (let k = 1; k <= 7; k++) g.lineTo(px + (pw * k) / 7 + (r() - 0.5) * 6, py + (k % 2 ? 0 : ph * (0.6 + r() * 0.35)));
        g.lineTo(px + pw * 0.2, py + ph);
        g.closePath();
        g.fill();
      }
    }
    if (kind === 5) {
      for (let y = 0; y < FH; y += 32) {
        g.fillStyle = 'rgba(0,0,0,0.13)';
        g.fillRect(0, y, FW, 2);
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.fillRect(0, y + 2, FW, 1);
      }
    }
  } else if (kind === 3) {
    // cut stone blocks
    for (let y = 0, row = 0; y < FH; y += 64, row++) {
      for (let x = -(row % 2) * 64; x < FW; x += 128) {
        const v = (r() - 0.5) * 18;
        g.fillStyle = `rgb(${base[0] + v},${base[1] + v},${base[2] + v})`;
        g.fillRect(x + 1, y + 1, 126, 62);
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.2)';
    for (let y = 0; y < FH; y += 64) g.fillRect(0, y, FW, 1.5);
  }

  const glass = (x: number, y: number, w: number, h: number, bright: number) => {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, `rgb(${150 * bright},${190 * bright},${222 * bright})`);
    gr.addColorStop(0.55, `rgb(${70 * bright},${100 * bright},${130 * bright})`);
    gr.addColorStop(1, `rgb(${24 * bright},${34 * bright},${48 * bright})`);
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  };

  for (let rr = 0; rr < 8; rr++) {
    for (let b = 0; b < 4; b++) {
      const x = b * BAY;
      const y = rr * BAY;
      const bright = 0.75 + r() * 0.5;
      if (glassKind) {
        // curtain-wall panel with spandrel and aluminium mullions
        g.fillStyle = kind === 2 ? '#1c2630' : '#26303a';
        g.fillRect(x, y, BAY, BAY);
        glass(x + 4, y + 4, BAY - 8, BAY * 0.72, bright);
        g.fillStyle = kind === 2 ? '#2d4052' : '#46525e';
        g.fillRect(x + 4, y + BAY * 0.78, BAY - 8, BAY * 0.2);
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.beginPath();
        g.moveTo(x + 4, y + 4);
        g.lineTo(x + BAY * 0.6, y + 4);
        g.lineTo(x + 4, y + BAY * 0.55);
        g.closePath();
        g.fill();
        g.fillStyle = '#9aa3ad';
        g.fillRect(x, y, 3, BAY);
        g.fillRect(x, y, BAY, 3);
      } else {
        const wx = x + 24;
        const wy = y + 20;
        const ww = 80;
        const wh = 78;
        // reveal shadow gives the opening depth
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.fillRect(wx - 4, wy - 4, ww + 8, wh + 8);
        g.fillStyle = '#2a2d31';
        g.fillRect(wx, wy, ww, wh);
        glass(wx + 4, wy + 4, ww - 8, wh - 8, bright);
        // curtain or blind
        const cr = r();
        if (cr < 0.35) {
          g.fillStyle = 'rgba(236,226,206,0.55)';
          g.fillRect(wx + 4, wy + 4, (ww - 8) * (0.35 + r() * 0.4), wh - 8);
        } else if (cr < 0.5) {
          g.fillStyle = 'rgba(220,214,200,0.6)';
          g.fillRect(wx + 4, wy + 4, ww - 8, (wh - 8) * (0.3 + r() * 0.5));
        }
        g.fillStyle = 'rgba(255,255,255,0.14)';
        g.beginPath();
        g.moveTo(wx + 4, wy + 4);
        g.lineTo(wx + ww * 0.6, wy + 4);
        g.lineTo(wx + 4, wy + wh * 0.7);
        g.closePath();
        g.fill();
        g.fillStyle = '#2a2d31';
        g.fillRect(wx + ww / 2 - 2, wy, 4, wh);
        g.fillRect(wx, wy + wh * 0.4, ww, 3);
        // inner top/left shadow
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(wx + 4, wy + 4, ww - 8, 4);
        g.fillRect(wx + 4, wy + 4, 3, wh - 8);
        // sill, drip shadow and lintel
        g.fillStyle = '#d6d1c4';
        g.fillRect(wx - 7, wy + wh, ww + 14, 7);
        g.fillStyle = 'rgba(255,255,255,0.4)';
        g.fillRect(wx - 7, wy + wh, ww + 14, 1.5);
        const sh = g.createLinearGradient(0, wy + wh + 7, 0, wy + wh + 22);
        sh.addColorStop(0, 'rgba(0,0,0,0.38)');
        sh.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = sh;
        g.fillRect(wx - 7, wy + wh + 7, ww + 14, 15);
        if (kind === 3 || kind === 5 || kind === 1) {
          g.fillStyle = '#cbc6b8';
          g.fillRect(wx - 6, wy - 9, ww + 12, 7);
        }
        if (kind >= 6) {
          // timber louvred shutters either side of the opening, one leaf often left ajar
          const sc = SHUTTER[(kind + rr * 3 + b) % SHUTTER.length];
          const open = r() < 0.4;
          for (const leaf of [-1, 1]) {
            const lw = open && leaf > 0 ? 9 : 22;
            const lx = leaf < 0 ? wx - lw - 1 : wx + ww + 1;
            g.fillStyle = css(sc);
            g.fillRect(lx, wy - 2, lw, wh + 4);
            g.fillStyle = 'rgba(0,0,0,0.3)';
            for (let ly = wy + 2; ly < wy + wh; ly += 5) g.fillRect(lx + 1, ly, lw - 2, 1.4);
            g.fillStyle = 'rgba(255,255,255,0.14)';
            for (let ly = wy + 3.4; ly < wy + wh; ly += 5) g.fillRect(lx + 1, ly, lw - 2, 0.8);
            g.fillStyle = 'rgba(0,0,0,0.35)';
            g.fillRect(leaf < 0 ? lx : lx + lw - 1.5, wy - 2, 1.5, wh + 4);
          }
          // washing hung out to dry
          if (r() < 0.18) {
            g.strokeStyle = 'rgba(30,30,30,0.7)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(wx - 20, wy + wh + 14);
            g.lineTo(wx + ww + 20, wy + wh + 16);
            g.stroke();
            for (let k = 0; k < 4; k++) {
              g.fillStyle = `hsl(${r() * 360},60%,${50 + r() * 20}%)`;
              g.fillRect(wx - 14 + k * 28, wy + wh + 15, 12 + r() * 8, 16 + r() * 10);
            }
          }
        }
        // iron balcony railing on alternate floors
        if (kind === 5 && rr % 2 === 1) {
          g.strokeStyle = '#1d2024';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(wx - 14, wy + wh - 18);
          g.lineTo(wx + ww + 14, wy + wh - 18);
          g.moveTo(wx - 14, wy + wh + 6);
          g.lineTo(wx + ww + 14, wy + wh + 6);
          g.stroke();
          g.lineWidth = 1.2;
          for (let k = wx - 12; k <= wx + ww + 12; k += 7) {
            g.beginPath();
            g.moveTo(k, wy + wh - 18);
            g.lineTo(k, wy + wh + 6);
            g.stroke();
          }
          g.fillStyle = 'rgba(0,0,0,0.25)';
          g.fillRect(wx - 14, wy + wh + 7, ww + 28, 10);
        }
        // wall-mounted AC unit on some windows
        if (r() < (kind >= 6 ? 0.22 : 0.1)) {
          g.fillStyle = '#d8dadd';
          g.fillRect(wx + ww + 8, wy + wh - 22, 26, 20);
          g.fillStyle = '#7a7e84';
          g.fillRect(wx + ww + 10, wy + wh - 18, 22, 12);
        }
      }
    }
  }

  // long streaky water staining
  for (let i = 0; i < 90; i++) {
    const x = r() * FW;
    const y = r() * FH;
    const len = 40 + r() * 140;
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, `rgba(30,24,18,${0.08 + r() * 0.1})`);
    gr.addColorStop(1, 'rgba(30,24,18,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, 3 + r() * 9, len);
  }
  // floor-line shadow beneath every slab
  for (let rr = 1; rr < 8; rr++) {
    const gr = g.createLinearGradient(0, rr * BAY, 0, rr * BAY + 14);
    gr.addColorStop(0, 'rgba(0,0,0,0.28)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, rr * BAY, FW, 14);
  }
  paintGrain(g, FW, FH, grain, 0.9);

  const avg = mix(WALL[kind], [90, 100, 112], glassKind ? 0.5 : 0.1);
  return { kind, albedo: c, emis: null, avg };
}

/** lit-window map for night, same geometry as the facade windows */
function buildEmissive(fac: Facade): Cv {
  const c = canvas(FW * FSCALE, FH * FSCALE);
  const g = ctxOf(c);
  g.scale(FSCALE, FSCALE);
  const r = rng(5000 + fac.kind * 31);
  g.fillStyle = '#000';
  g.fillRect(0, 0, FW, FH);
  const glassKind = fac.kind === 2 || fac.kind === 4;
  for (let rr = 0; rr < 8; rr++) {
    for (let b = 0; b < 4; b++) {
      if (r() > 0.4) continue;
      const tv = r() < 0.15;
      const v = 0.55 + r() * 0.45;
      const x = b * BAY + (glassKind ? 4 : 28);
      const y = rr * BAY + (glassKind ? 4 : 24);
      const w = glassKind ? BAY - 8 : 72;
      const h = glassKind ? BAY * 0.72 : 70;
      const gr = g.createLinearGradient(0, y, 0, y + h);
      if (tv) {
        gr.addColorStop(0, `rgb(${150 * v},${190 * v},${255 * v})`);
        gr.addColorStop(1, `rgb(${60 * v},${90 * v},${170 * v})`);
      } else {
        gr.addColorStop(0, `rgb(${255 * v},${214 * v},${140 * v})`);
        gr.addColorStop(1, `rgb(${230 * v},${150 * v},${70 * v})`);
      }
      g.fillStyle = gr;
      g.fillRect(x, y, w, h);
      if (!glassKind) {
        g.fillStyle = '#000';
        g.fillRect(x + w / 2 - 2, y, 4, h);
        g.fillRect(x, y + h * 0.4, w, 3);
      }
    }
  }
  return c;
}

function buildShop(variant: number, color: RGB, grain: Cv): Shop {
  const c = canvas(FW * FSCALE, SHOP_PX * FSCALE);
  const g = ctxOf(c);
  g.scale(FSCALE, FSCALE);
  const r = rng(7000 + variant * 53);
  g.fillStyle = '#34312d';
  g.fillRect(0, 0, FW, SHOP_PX);
  const bayW = FW / (2 + (variant % 2));
  const bays = FW / bayW;
  for (let b = 0; b < bays; b++) {
    const x = b * bayW;
    // fascia sign
    g.fillStyle = css(color);
    g.fillRect(x + 6, 4, bayW - 12, 30);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let k = 0; k < 6; k++) g.fillRect(x + 22 + k * 22, 12, 14 + r() * 6, 14);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x + 6, 30, bayW - 12, 4);
    // striped awning with scalloped hem
    const ay = 38;
    for (let s = 0; s * 22 < bayW - 12; s++) {
      g.fillStyle = s % 2 ? '#f1ede4' : css(mix(color, [0, 0, 0], 0.15));
      g.fillRect(x + 6 + s * 22, ay, 22, 22);
      g.beginPath();
      g.arc(x + 17 + s * 22, ay + 22, 11, 0, Math.PI);
      g.fill();
    }
    const sh = g.createLinearGradient(0, ay + 34, 0, ay + 60);
    sh.addColorStop(0, 'rgba(0,0,0,0.5)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh;
    g.fillRect(x + 6, ay + 34, bayW - 12, 26);
    // display glass with shelves
    const gy = 100;
    const gh = SHOP_PX - gy - 10;
    const gr = g.createLinearGradient(0, gy, 0, gy + gh);
    gr.addColorStop(0, '#4a5a68');
    gr.addColorStop(1, '#1e262e');
    g.fillStyle = gr;
    g.fillRect(x + 10, gy, bayW - 20, gh);
    for (let k = 0; k < 14; k++) {
      g.fillStyle = `rgba(${80 + r() * 160},${80 + r() * 140},${60 + r() * 140},0.75)`;
      g.fillRect(x + 16 + r() * (bayW - 50), gy + 12 + r() * (gh - 34), 10 + r() * 22, 8 + r() * 18);
    }
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.moveTo(x + 10, gy);
    g.lineTo(x + 10 + (bayW - 20) * 0.5, gy);
    g.lineTo(x + 10, gy + gh * 0.8);
    g.closePath();
    g.fill();
    g.fillStyle = '#16181b';
    g.fillRect(x + bayW / 2 - 1.5, gy, 3, gh);
  }
  // door in the first bay
  g.fillStyle = '#17191c';
  g.fillRect(bayW * 0.55, 98, 56, SHOP_PX - 108);
  g.fillStyle = 'rgba(160,190,210,0.4)';
  g.fillRect(bayW * 0.55 + 6, 104, 44, SHOP_PX - 130);
  g.fillStyle = '#c9ccd0';
  g.fillRect(bayW * 0.55 + 44, 138, 3, 20);
  // plinth and pilasters
  g.fillStyle = '#8c887e';
  g.fillRect(0, SHOP_PX - 12, FW, 12);
  g.fillStyle = '#6e6a62';
  for (let b = 0; b <= bays; b++) g.fillRect(b * bayW - 4, 0, 8, SHOP_PX);
  paintGrain(g, FW, SHOP_PX, grain, 0.8);
  return { albedo: c, emis: null, color };
}

function buildShopEmissive(shop: Shop, variant: number): Cv {
  const c = canvas(FW * FSCALE, SHOP_PX * FSCALE);
  const g = ctxOf(c);
  g.scale(FSCALE, FSCALE);
  g.fillStyle = '#000';
  g.fillRect(0, 0, FW, SHOP_PX);
  const bayW = FW / (2 + (variant % 2));
  const bays = FW / bayW;
  for (let b = 0; b < bays; b++) {
    const x = b * bayW;
    g.fillStyle = css(mix(shop.color, [255, 255, 255], 0.2));
    g.fillRect(x + 6, 4, bayW - 12, 30);
    const gr = g.createLinearGradient(0, 100, 0, SHOP_PX);
    gr.addColorStop(0, 'rgb(255,226,160)');
    gr.addColorStop(1, 'rgb(200,140,70)');
    g.fillStyle = gr;
    g.fillRect(x + 10, 100, bayW - 20, SHOP_PX - 110);
    g.fillStyle = '#000';
    g.fillRect(x + bayW / 2 - 1.5, 100, 3, SHOP_PX - 110);
  }
  return c;
}

// ---------------------------------------------------------------- sprites
function buildTree(): Cv {
  const S = 256;
  const c = canvas(S, S);
  const g = ctxOf(c);
  const r = rng(424242);
  const cx = S / 2;
  const cy = S / 2;
  g.fillStyle = '#1f3a22';
  g.beginPath();
  g.arc(cx, cy + 8, 104, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 1700; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 112;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d * 0.95;
    const light = 1 - (x - cx + (y - cy)) / 340;
    const v = 0.55 + light * 0.5 + (r() - 0.5) * 0.25;
    g.fillStyle = `rgb(${(54 + r() * 30) * v},${(110 + r() * 50) * v},${(46 + r() * 26) * v})`;
    g.beginPath();
    g.ellipse(x, y, 3 + r() * 6, 2.5 + r() * 5, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function buildCloud(): Cv {
  const c = canvas(512, 200);
  const g = ctxOf(c);
  const r = rng(31337);
  for (let i = 0; i < 70; i++) {
    const x = 90 + r() * 330;
    const y = 80 + (r() - 0.5) * 60 - Math.sin(((x - 90) / 330) * Math.PI) * 24;
    const rad = 26 + r() * 46;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(255,255,255,0.5)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return c;
}

interface Assets {
  ground: Cv[];
  facades: Facade[];
  shops: Shop[];
  tree: Cv;
  treeNight: Cv;
  cloud: Cv;
}

let facadeCache: Facade[] | null = null;

/** wall textures shared with the 3D map: 0 brick, 1 stucco, 2 glass, 3 stone, 4 modern glass, 5 sandstone */
export function facadeSet(): Facade[] {
  if (!facadeCache) {
    const grain = grainTile(256, 0.2, 99);
    facadeCache = Array.from({ length: KINDS }, (_, k) => buildFacade(k, grain));
  }
  return facadeCache;
}

export const FACADE_SIZE = { w: FW, h: FH };

let cache: Assets | null = null;

function assets(): Assets {
  if (cache) return cache;
  const grain = grainTile(256, 0.2, 99);
  const shopColors: RGB[] = [[196, 58, 54], [46, 108, 166], [212, 156, 38], [58, 136, 94], [120, 70, 150], [220, 110, 40]];
  const tree = buildTree();
  cache = {
    ground: buildGround(),
    facades: facadeSet(),
    shops: shopColors.map((col, i) => buildShop(i, col, grain)),
    tree,
    treeNight: tinted(tree, 'rgba(6,14,34,0.72)'),
    cloud: buildCloud(),
  };
  return cache;
}

const CAM_H = 3.2;
const SPACING = 16;
const FAR = 520;
const SPEED = 22;

/**
 * Procedural train's-eye view through a city: wide field of view, no cab in shot.
 * Generated textures (tarmac, ballast, brick, glass, shopfronts) are projected onto the street
 * scanline by scanline, and onto buildings per column, so they converge in true perspective.
 */
export function CabinBackdrop({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    // the opaque backdrop hides the map, so stop it spinning (and re-rendering) underneath
    mapCtl.stopOrbit();
    // textures are painted just after first paint so the page appears immediately
    let A: Assets | null = null;
    const buildTimer = window.setTimeout(() => {
      A = assets();
      if (still) draw();
    }, 60);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let dist = 0;
    let last = performance.now();
    let clock = 0;

    const resize = () => {
      // phones draw at ~0.6x and let the browser scale the canvas up: a quarter of the pixels to fill
      dpr = LOW_END ? 0.6 : Math.min(window.devicePixelRatio || 1, 1.5);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();

    const draw = () => {
      const AS = A;
      if (!AS) return;
      const look = document.documentElement.dataset.theme === 'dark' ? NIGHT : DAY;
      const night = look.night;
      const horizon = h * 0.5;
      const f = Math.max(w * 0.4, h * 0.62);
      const bend = Math.sin(clock * 0.1) * 0.8 + Math.sin(clock * 0.043 + 1.3) * 0.5;
      const camX = w / 2 + Math.sin(clock * 1.7) * 1.4 + Math.sin(clock * 3.1) * 0.7;
      const roll = Math.sin(clock * 1.3) * 0.0012;
      const curve = (z: number) => bend * z * z * 0.0009;
      const sx = (x: number, z: number) => camX + ((x + curve(z)) / z) * f;
      const sy = (y: number, z: number) => horizon + ((CAM_H - y) / z) * f;
      const fog = (z: number) => 1 - Math.exp(-z / 190);
      const fogged = (c: RGB, z: number): RGB => mix(c, look.skyLow, fog(z) * 0.9);

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(w / 2, h / 2);
      ctx.rotate(roll);
      ctx.scale(1.03, 1.03);
      ctx.translate(-w / 2, -h / 2);

      // ---- sky
      const sky = ctx.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, css(look.skyTop));
      sky.addColorStop(1, css(look.skyLow));
      ctx.fillStyle = sky;
      ctx.fillRect(-40, -40, w + 80, horizon + 40);
      if (night) {
        for (let i = 0; i < 90; i++) {
          ctx.fillStyle = `rgba(255,255,255,${0.2 + hash(i, 5) * 0.6})`;
          const s = hash(i, 6) > 0.9 ? 2 : 1.2;
          ctx.fillRect(hash(i, 1) * w, hash(i, 2) * horizon * 0.85, s, s);
        }
      } else {
        const sun = ctx.createRadialGradient(w * 0.72, horizon * 0.55, 0, w * 0.72, horizon * 0.55, h * 0.5);
        sun.addColorStop(0, 'rgba(255,248,224,0.7)');
        sun.addColorStop(1, 'rgba(255,248,224,0)');
        ctx.fillStyle = sun;
        ctx.fillRect(-40, -40, w + 80, horizon + 40);
        for (let i = 0; i < 5; i++) {
          const cw = 280 + hash(i, 13) * 320;
          const cx = ((hash(i, 11) * (w + cw * 2) + clock * (4 + i * 1.3)) % (w + cw * 2)) - cw;
          const cy = horizon * (0.1 + hash(i, 12) * 0.55);
          ctx.globalAlpha = 0.85;
          ctx.drawImage(AS.cloud, cx, cy, cw, cw * 0.39);
          ctx.globalAlpha = 1;
        }
      }

      // ---- ground base, then perspective-mapped atlas scanlines
      ctx.fillStyle = css(look.ground);
      ctx.fillRect(-40, horizon, w + 80, h - horizon + 40);

      const skyOff = clock * 5 + bend * 50;
      ctx.fillStyle = css(mix([120, 140, 160], look.skyLow, night ? 0.35 : 0.72));
      for (let i = -2; i < w / 40 + 3; i++) {
        const idx = Math.floor((i * 40 + skyOff) / 40);
        const bw = 30 + hash(idx, 1) * 50;
        const bh = 20 + hash(idx, 2) * (h * 0.16);
        ctx.fillRect(i * 40 - (skyOff % 40) - bw * 0.3, horizon - bh, bw, bh + 2);
      }

      const rowStart = Math.ceil(horizon + (CAM_H * f) / FAR);
      const rowEnd = Math.ceil(h * 1.05 + 40);
      const rowStep = LOW_END ? 2 : 1;
      for (let row = rowEnd; row >= rowStart; row -= rowStep) {
        const zc = (CAM_H * f) / (row + 0.5 - horizon);
        const dz = (zc * zc) / (CAM_H * f);
        const texRows = dz * (1024 / GROUND_M);
        const lvl = texRows > 9 ? 3 : texRows > 4.5 ? 2 : texRows > 2.2 ? 1 : 0;
        const img = AS.ground[lvl];
        const S = img.width;
        const ppm = S / GROUND_M;
        const srcH = Math.max(1, dz * ppm);
        const ty = Math.min(((zc + dist) % GROUND_M) * ppm, S - srcH);
        const dx = sx(-16, zc);
        const dw = (GROUND_M / zc) * f;
        const u0 = Math.min(1, Math.max(0, (-40 - dx) / dw));
        const u1 = Math.min(1, Math.max(0, (w + 40 - dx) / dw));
        if (u1 <= u0) continue;
        ctx.drawImage(img, u0 * S, ty, (u1 - u0) * S, srcH, dx + u0 * dw, row - 0.3, (u1 - u0) * dw, 1.7 * rowStep);
      }
      if (night) {
        ctx.fillStyle = 'rgba(6,12,34,0.7)';
        ctx.fillRect(-40, horizon, w + 80, h - horizon + 40);
      } else {
        const tone = ctx.createLinearGradient(0, horizon, 0, h);
        tone.addColorStop(0, 'rgba(255,240,210,0)');
        tone.addColorStop(1, 'rgba(255,236,200,0.08)');
        ctx.fillStyle = tone;
        ctx.fillRect(-40, horizon, w + 80, h - horizon + 40);
      }

      // rails
      ctx.lineCap = 'round';
      for (const rx of [-0.72, 0.72]) {
        ctx.beginPath();
        for (let z = 1.2; z <= FAR; z *= 1.05) {
          if (z === 1.2) ctx.moveTo(sx(rx, z), sy(0, z));
          else ctx.lineTo(sx(rx, z), sy(0, z));
        }
        ctx.strokeStyle = night ? 'rgba(120,132,156,0.9)' : 'rgba(132,136,142,0.95)';
        ctx.lineWidth = Math.max(1.6, (0.075 / 1.4) * f);
        ctx.stroke();
        ctx.strokeStyle = css(look.rail, night ? 0.5 : 0.7);
        ctx.lineWidth = Math.max(1, (0.025 / 1.4) * f);
        ctx.stroke();
      }

      // ground fog toward the horizon
      const gfog = ctx.createLinearGradient(0, horizon, 0, horizon + (h - horizon) * 0.55);
      gfog.addColorStop(0, css(look.skyLow, 1));
      gfog.addColorStop(1, css(look.skyLow, 0));
      ctx.fillStyle = gfog;
      ctx.fillRect(-40, horizon - 1, w + 80, (h - horizon) * 0.55 + 1);

      // ---- city wall, trees, lamps, masts: far to near
      const first = Math.floor(dist / SPACING);
      const slots = Math.ceil(FAR / SPACING) + 1;
      const dayTints = ['rgba(255,170,120,0.10)', 'rgba(120,170,255,0.08)', 'rgba(255,230,160,0.10)', 'rgba(150,255,190,0.06)', 'rgba(255,255,255,0.04)'];

      for (let k = slots; k >= 0; k--) {
        const idx = first + k;
        const z = idx * SPACING - dist;
        if (z < 2 || z > FAR) continue;
        const fg = fog(z);

        for (const side of [-1, 1]) {
          const salt = side > 0 ? 7 : 3;

          if (hash(idx, salt + 40) > 0.1) {
            const bw = 14 + hash(idx, salt) * 16;
            const depth = SPACING * 0.92;
            const inner = 16.4 + hash(idx, salt + 2) * 3;
            const floors = 4 + Math.floor(Math.pow(hash(idx, salt + 3), 1.5) * 20);
            const bh = floors * 3.4 + SHOP_H;
            const fac = AS.facades[Math.floor(hash(idx, salt + 4) * KINDS)];
            const shop = AS.shops[Math.floor(hash(idx, salt + 6) * AS.shops.length)];
            const shopIdx = AS.shops.indexOf(shop);
            const xin = side * inner;
            const xout = side * (inner + bw);
            const zb = z + depth;
            const near = z < (LOW_END ? 95 : 150);

            // ---- inner side face
            const x0 = sx(xin, z);
            const x1 = sx(xin, zb);
            const sideShade = night ? 'rgba(6,10,30,0.74)' : 'rgba(10,12,20,0.34)';
            const quadPath = () => {
              ctx.beginPath();
              ctx.moveTo(x0, sy(0, z));
              ctx.lineTo(x1, sy(0, zb));
              ctx.lineTo(x1, sy(bh, zb));
              ctx.lineTo(x0, sy(bh, z));
              ctx.closePath();
            };
            if (near && Math.abs(x0 - x1) > 3) {
              const sideLayer = (img: Cv) => {
                const lo = Math.max(-10, Math.min(x0, x1));
                const hi = Math.min(w + 10, Math.max(x0, x1));
                const step = LOW_END ? 6 : Math.abs(x0 - x1) > 160 ? 4 : 3;
                for (let xs = lo; xs < hi; xs += step) {
                  const rel = xs + step / 2 - camX;
                  if (Math.abs(rel) < 1) continue;
                  const zc = Math.min(zb, Math.max(z, (xin * f) / rel));
                  const z2 = Math.min(zb, Math.max(z, (xin * f) / (rel + step * (side > 0 ? 1 : -1))));
                  const um = zc - z;
                  const sw = Math.max(1, Math.abs(z2 - zc) * PPM_F);
                  const sxp = Math.min(FW - sw, (um * PPM_F) % FW);
                  const topFull = sy(bh, zc);
                  const botFull = sy(0, zc);
                  const vis0 = Math.max(topFull, -20);
                  const vis1 = Math.min(botFull, h + 20);
                  if (vis1 <= vis0) continue;
                  for (let j = 0; j * TH < bh; j++) {
                    const y0 = j * TH;
                    const ymax = Math.min(bh, y0 + TH);
                    const dt = sy(ymax, zc);
                    const db = sy(y0, zc);
                    if (db < -20 || dt > h + 20) continue;
                    const mh = ymax - y0;
                    const srcY = FH * (1 - mh / TH);
                    ctx.drawImage(img, sxp * FSCALE, srcY * FSCALE, sw * FSCALE, (FH - srcY) * FSCALE, xs, dt, step + 0.6, db - dt + 0.6);
                  }
                }
              };
              sideLayer(fac.albedo);
              ctx.fillStyle = sideShade;
              quadPath();
              ctx.fill();
              if (night) {
                if (!fac.emis) fac.emis = buildEmissive(fac);
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.85;
                sideLayer(fac.emis);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
              }
            } else {
              ctx.fillStyle = css(fogged(mix(fac.avg, [0, 0, 0], night ? 0.75 : 0.3), z));
              quadPath();
              ctx.fill();
            }
            ctx.fillStyle = css(look.skyLow, fg * 0.92);
            quadPath();
            ctx.fill();

            // ---- front face
            const sxa = sx(xin, z);
            const sxb = sx(xout, z);
            const left = Math.min(sxa, sxb);
            const pxW = Math.abs(sxb - sxa);
            const top = sy(bh, z);
            const bot = sy(0, z);
            if (near && pxW > 10) {
              const frontLayer = (fi: Cv, si: Cv) => {
                for (let i = 0; i * TW < bw; i++) {
                  const mw = Math.min(TW, bw - i * TW);
                  const xa = sx(side * (inner + i * TW), z);
                  const xb = sx(side * (inner + i * TW + mw), z);
                  const dl = Math.min(xa, xb);
                  const dwid = Math.abs(xb - xa);
                  if (dl > w + 20 || dl + dwid < -20) continue;
                  const srcW = mw * PPM_F;
                  for (let j = 0; SHOP_H + j * TH < bh; j++) {
                    const y0 = SHOP_H + j * TH;
                    const ymax = Math.min(bh, y0 + TH);
                    const mh = ymax - y0;
                    const srcY = FH * (1 - mh / TH);
                    const dt = sy(ymax, z);
                    const db = sy(y0, z);
                    ctx.drawImage(fi, 0, srcY * FSCALE, srcW * FSCALE, (FH - srcY) * FSCALE, dl, dt, dwid, db - dt + 0.6);
                  }
                  ctx.drawImage(si, 0, 0, srcW * FSCALE, SHOP_PX * FSCALE, dl, sy(SHOP_H, z), dwid, sy(0, z) - sy(SHOP_H, z) + 0.6);
                }
              };
              frontLayer(fac.albedo, shop.albedo);
              ctx.fillStyle = dayTints[Math.floor(hash(idx, salt + 8) * dayTints.length)];
              ctx.fillRect(left, top, pxW, bot - top);
              if (night) {
                ctx.fillStyle = 'rgba(6,10,30,0.66)';
                ctx.fillRect(left, top, pxW, bot - top);
                if (!fac.emis) fac.emis = buildEmissive(fac);
                if (!shop.emis) shop.emis = buildShopEmissive(shop, shopIdx);
                ctx.globalCompositeOperation = 'lighter';
                frontLayer(fac.emis, shop.emis);
                ctx.globalCompositeOperation = 'source-over';
              } else {
                const sh = ctx.createLinearGradient(0, top, 0, bot);
                sh.addColorStop(0, 'rgba(255,255,255,0.1)');
                sh.addColorStop(1, 'rgba(0,0,0,0.12)');
                ctx.fillStyle = sh;
                ctx.fillRect(left, top, pxW, bot - top);
              }
              // parapet edge catches the light
              ctx.fillStyle = night ? 'rgba(120,140,190,0.25)' : 'rgba(255,255,255,0.35)';
              ctx.fillRect(left, top, pxW, Math.max(1, (0.3 / z) * f));
            } else {
              ctx.fillStyle = css(fogged(mix(fac.avg, [0, 0, 0], night ? 0.6 : 0.05), z));
              ctx.fillRect(left, top, pxW, bot - top);
            }
            ctx.fillStyle = css(look.skyLow, fg * 0.92);
            ctx.fillRect(left, top, pxW, bot - top);
          }

          // street tree
          if (z > 3 && hash(idx, salt + 50) > 0.4) {
            const tz = z + 4 + hash(idx, salt + 51) * 4;
            const tx = side * 15;
            ctx.strokeStyle = css(fogged(night ? [24, 20, 18] : [70, 52, 40], tz));
            ctx.lineWidth = Math.max(1.5, (0.32 / tz) * f);
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(sx(tx, tz), sy(0, tz));
            ctx.lineTo(sx(tx, tz), sy(3.8, tz));
            ctx.stroke();
            const rr = (3.1 / tz) * f;
            ctx.globalAlpha = 1 - fog(tz) * 0.85;
            ctx.drawImage(night ? AS.treeNight : AS.tree, sx(tx, tz) - rr, sy(5.6, tz) - rr, rr * 2, rr * 2);
            ctx.globalAlpha = 1;
          }

          // street lamp
          if (z > 2.5 && idx % 2 === 0) {
            const lz = z + 1;
            const lx = side * 13.8;
            ctx.strokeStyle = css(fogged([48, 54, 62], lz));
            ctx.lineWidth = Math.max(1, (0.18 / lz) * f);
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(sx(lx, lz), sy(0, lz));
            ctx.lineTo(sx(lx, lz), sy(8, lz));
            ctx.lineTo(sx(lx - side * 1.6, lz), sy(8.3, lz));
            ctx.stroke();
            if (night) {
              const gx = sx(lx - side * 1.6, lz);
              const gy = sy(8.3, lz);
              const gr = Math.max(6, (4.5 / lz) * f);
              const lg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
              lg.addColorStop(0, 'rgba(255,232,176,0.95)');
              lg.addColorStop(0.3, 'rgba(255,220,150,0.35)');
              lg.addColorStop(1, 'rgba(255,220,150,0)');
              ctx.fillStyle = lg;
              ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
            }
          }
        }

        // overhead mast gantry
        if (idx % 2 === 1) {
          ctx.strokeStyle = css(fogged([44, 50, 60], z));
          ctx.lineCap = 'butt';
          ctx.lineWidth = Math.max(1, (0.22 / z) * f);
          for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(sx(side * 3.1, z), sy(0, z));
            ctx.lineTo(sx(side * 3.1, z), sy(7.2, z));
            ctx.stroke();
          }
          ctx.lineWidth = Math.max(1, (0.12 / z) * f);
          ctx.beginPath();
          ctx.moveTo(sx(-3.1, z), sy(6.8, z));
          ctx.lineTo(sx(3.1, z), sy(6.8, z));
          ctx.stroke();
        }
      }

      // tangled overhead cables between lamp poles
      for (let k = 0; k < 14; k++) {
        const idx = first + k;
        const z = idx * SPACING - dist;
        if (z < 3 || z > 260 || idx % 2 !== 0) continue;
        const fg2 = fog(z);
        ctx.strokeStyle = css(mix([30, 32, 38], look.skyLow, fg2), 0.85);
        ctx.lineWidth = Math.max(0.8, (0.05 / z) * f);
        for (let c = 0; c < 3; c++) {
          const hy = 6.4 + c * 0.55;
          const sag = 0.9 + hash(idx, 80 + c) * 1.1;
          ctx.beginPath();
          ctx.moveTo(sx(-13.8, z), sy(hy, z));
          ctx.quadraticCurveTo(sx(0, z), sy(hy - sag * 2, z), sx(13.8, z), sy(hy + hash(idx, 83 + c) * 0.6, z));
          ctx.stroke();
        }
      }

      // yellow taxis and buses sharing the street, each at its own pace
      const LOOP = 320;
      const traffic = [] as { z: number; x: number; kind: number; i: number }[];
      for (let i = 0; i < 12; i++) {
        const lane = i % 4;
        const x = [-11.2, -6.9, 6.9, 11.2][lane];
        // cars on the outer lanes run with the train, the inner ones against it
        const v = lane === 1 || lane === 2 ? -9 - hash(i, 90) * 6 : 8 + hash(i, 91) * 6;
        const z = (((hash(i, 92) * LOOP - (SPEED - v) * clock) % LOOP) + LOOP) % LOOP + 5;
        traffic.push({ z, x, kind: Math.floor(hash(i, 93) * 4), i });
      }
      traffic.sort((a, b) => b.z - a.z);
      for (const car of traffic) {
        const { z, x } = car;
        if (z > 240) continue;
        const bus = car.kind === 3;
        const cw = bus ? 2.5 : 1.8;
        const body = bus ? [188, 52, 48] : car.kind === 2 ? [236, 236, 230] : [244, 190, 30];
        const bodyC = mix(body as RGB, look.skyLow, fog(z) * 0.8);
        const dark = night ? 0.45 : 1;
        const L = sx(x - cw / 2, z);
        const R = sx(x + cw / 2, z);
        const wpx = R - L;
        const y0 = sy(0.28, z);
        const y1 = sy(bus ? 3.0 : 1.1, z);
        // soft contact shadow
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(L - wpx * 0.06, sy(0, z) - wpx * 0.05, wpx * 1.12, wpx * 0.08);
        const d = (c3: number) => Math.min(255, c3 * dark);
        const pg = ctx.createLinearGradient(0, y1, 0, y0);
        pg.addColorStop(0, css([d(bodyC[0] * 1.12), d(bodyC[1] * 1.12), d(bodyC[2] * 1.12)]));
        pg.addColorStop(0.6, css([d(bodyC[0]), d(bodyC[1]), d(bodyC[2])]));
        pg.addColorStop(1, css([d(bodyC[0] * 0.7), d(bodyC[1] * 0.7), d(bodyC[2] * 0.7)]));
        ctx.fillStyle = pg;
        ctx.fillRect(L, y1, wpx, y0 - y1);
        // glazing with a sky reflection, and the roof line
        const gTop = sy(bus ? 3.0 : 1.62, z);
        const gBot = sy(bus ? 1.5 : 1.12, z);
        const gg = ctx.createLinearGradient(0, gTop, 0, gBot);
        gg.addColorStop(0, css(mix([120, 150, 180], look.skyLow, fog(z) * 0.6), 0.95));
        gg.addColorStop(1, css(mix([22, 28, 38], look.skyLow, fog(z) * 0.6), 0.95));
        ctx.fillStyle = gg;
        ctx.fillRect(L + wpx * 0.1, gTop, wpx * 0.8, gBot - gTop);
        if (wpx > 14) {
          ctx.fillStyle = css([d(bodyC[0] * 0.75), d(bodyC[1] * 0.75), d(bodyC[2] * 0.75)]);
          ctx.fillRect(L + wpx * 0.48, gTop, Math.max(1, wpx * 0.04), gBot - gTop);
        }
        if (!bus) {
          ctx.fillStyle = css([d(bodyC[0]), d(bodyC[1]), d(bodyC[2])]);
          ctx.fillRect(L + wpx * 0.06, gTop - wpx * 0.05, wpx * 0.88, wpx * 0.06);
          // taxi roof sign
          ctx.fillStyle = car.kind === 2 ? 'rgba(30,30,30,0.9)' : 'rgba(255,255,255,0.9)';
          ctx.fillRect(L + wpx * 0.38, gTop - wpx * 0.12, wpx * 0.24, wpx * 0.07);
        } else {
          // bus: window bays and a destination board
          ctx.fillStyle = css([d(bodyC[0] * 0.8), d(bodyC[1] * 0.8), d(bodyC[2] * 0.8)]);
          for (let k = 1; k < 4; k++) ctx.fillRect(L + (wpx * k) / 4 - 0.5, gTop, Math.max(1, wpx * 0.02), gBot - gTop);
          ctx.fillStyle = 'rgba(255,176,32,0.95)';
          ctx.fillRect(L + wpx * 0.3, gTop - wpx * 0.06, wpx * 0.4, wpx * 0.04);
        }
        // bumper, plate, wheels with hubs, lights
        ctx.fillStyle = css(mix([30, 32, 38], look.skyLow, fog(z) * 0.5));
        ctx.fillRect(L - wpx * 0.02, y0 - wpx * 0.07, wpx * 1.04, wpx * 0.07);
        ctx.fillStyle = 'rgba(240,236,208,0.9)';
        ctx.fillRect(L + wpx * 0.4, y0 - wpx * 0.2, wpx * 0.2, wpx * 0.07);
        ctx.fillStyle = css(mix([14, 14, 16], look.skyLow, fog(z) * 0.5));
        ctx.fillRect(L + wpx * 0.06, y0 - wpx * 0.08, wpx * 0.18, wpx * 0.14);
        ctx.fillRect(R - wpx * 0.24, y0 - wpx * 0.08, wpx * 0.18, wpx * 0.14);
        if (wpx > 18) {
          ctx.fillStyle = 'rgba(170,176,186,0.8)';
          ctx.fillRect(L + wpx * 0.11, y0 - wpx * 0.04, wpx * 0.08, wpx * 0.06);
          ctx.fillRect(R - wpx * 0.19, y0 - wpx * 0.04, wpx * 0.08, wpx * 0.06);
        }
        const lampY = sy(0.75, z);
        const lr = Math.max(1, wpx * 0.06);
        ctx.fillStyle = night ? 'rgba(255,70,50,0.95)' : 'rgba(180,36,30,0.9)';
        ctx.fillRect(L + wpx * 0.06, lampY, lr * 1.6, lr);
        ctx.fillRect(R - wpx * 0.06 - lr * 1.6, lampY, lr * 1.6, lr);
        if (night) {
          const gr = Math.max(4, wpx * 0.5);
          for (const lx of [L + wpx * 0.1, R - wpx * 0.1]) {
            const lg = ctx.createRadialGradient(lx, lampY, 0, lx, lampY, gr);
            lg.addColorStop(0, 'rgba(255,60,40,0.5)');
            lg.addColorStop(1, 'rgba(255,60,40,0)');
            ctx.fillStyle = lg;
            ctx.fillRect(lx - gr, lampY - gr, gr * 2, gr * 2);
          }
        }
      }

      // people strolling along the pavements, some sheltering from the sun
      const folk = [] as { z: number; x: number; i: number }[];
      for (let i = 0; i < 22; i++) {
        const side = i % 2 ? 1 : -1;
        const v = (hash(i, 95) < 0.5 ? 1 : -1) * (1.0 + hash(i, 96) * 0.6);
        const z = (((hash(i, 97) * 200 - (SPEED - v) * clock) % 200) + 200) % 200 + 4;
        folk.push({ z, x: side * (14.9 + hash(i, 98) * 0.6), i });
      }
      folk.sort((p, q) => q.z - p.z);
      for (const person of folk) {
        const { z, x, i } = person;
        if (z > 150) continue;
        const hpx = (1.7 / z) * f;
        const cx = sx(x, z);
        const foot = sy(0, z);
        const swing = Math.sin(clock * 7 + i * 1.7) * hpx * 0.06;
        const fg3 = fog(z) * 0.8;
        const shirt = mix([[220, 70, 60], [60, 120, 200], [240, 200, 60], [90, 170, 110], [150, 90, 180], [235, 235, 230], [230, 130, 50]][i % 7] as RGB, look.skyLow, fg3);
        const dk = night ? 0.5 : 1;
        const legC = css(mix([36, 40, 54], look.skyLow, fg3));
        ctx.fillStyle = legC;
        ctx.fillRect(cx - hpx * 0.1 + swing, foot - hpx * 0.45, hpx * 0.08, hpx * 0.45);
        ctx.fillRect(cx + hpx * 0.02 - swing, foot - hpx * 0.45, hpx * 0.08, hpx * 0.45);
        ctx.fillStyle = css([shirt[0] * dk, shirt[1] * dk, shirt[2] * dk]);
        ctx.fillRect(cx - hpx * 0.13, foot - hpx * 0.82, hpx * 0.26, hpx * 0.4);
        ctx.fillStyle = css([shirt[0] * dk * 0.8, shirt[1] * dk * 0.8, shirt[2] * dk * 0.8]);
        ctx.fillRect(cx - hpx * 0.17 - swing * 0.6, foot - hpx * 0.8, hpx * 0.05, hpx * 0.32);
        ctx.fillRect(cx + hpx * 0.12 + swing * 0.6, foot - hpx * 0.8, hpx * 0.05, hpx * 0.32);
        const skinC = css(mix([196, 150, 112], look.skyLow, fg3));
        ctx.fillStyle = skinC;
        ctx.beginPath();
        ctx.arc(cx, foot - hpx * 0.9, hpx * 0.075, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = css(mix([24, 20, 18], look.skyLow, fg3));
        ctx.beginPath();
        ctx.arc(cx, foot - hpx * 0.91, hpx * 0.078, Math.PI, 0);
        ctx.fill();
        if (i % 4 === 1) {
          ctx.fillStyle = css(mix([90, 60, 40], look.skyLow, fg3));
          ctx.fillRect(cx + hpx * 0.12, foot - hpx * 0.62, hpx * 0.1, hpx * 0.14);
        }
        if (i % 3 === 0 && !night) {
          ctx.fillStyle = css(mix([30, 34, 44], look.skyLow, fg3));
          ctx.beginPath();
          ctx.arc(cx, foot - hpx * 1.02, hpx * 0.26, Math.PI, 0);
          ctx.fill();
        }
      }

      // contact wire
      ctx.strokeStyle = css(mix([44, 50, 60], look.skyLow, 0.4), 0.9);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let z = 2.5; z <= FAR; z *= 1.08) {
        const px = sx(0, z);
        const py = sy(5.8, z);
        if (z === 2.5) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      if (night) {
        const g = ctx.createRadialGradient(sx(0, 22), sy(0, 22), 4, sx(0, 22), sy(0, 22), h * 0.5);
        g.addColorStop(0, 'rgba(255,240,200,0.3)');
        g.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, horizon, w, h - horizon);
      }

      const haze = ctx.createLinearGradient(0, horizon - h * 0.16, 0, horizon + h * 0.04);
      haze.addColorStop(0, css(look.skyLow, 0));
      haze.addColorStop(0.7, css(look.skyLow, 0.5));
      haze.addColorStop(1, css(look.skyLow, 0));
      ctx.fillStyle = haze;
      ctx.fillRect(-40, horizon - h * 0.16, w + 80, h * 0.2);

      ctx.restore();
    };

    let lastDraw = 0;
    const tick = (t: number) => {
      if (LOW_END && t - lastDraw < 32) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastDraw = t;
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      clock += dt;
      dist += SPEED * dt;
      draw();
      raf = requestAnimationFrame(tick);
    };
    if (still) draw();
    else raf = requestAnimationFrame(tick);

    return () => {
      window.clearTimeout(buildTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
