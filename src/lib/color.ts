export type RGB = [number, number, number];

const cache = new Map<string, string | null>();
let ctx: CanvasRenderingContext2D | null = null;

/** Normalises any CSS colour (OSM `colour` tags are often named colours) to #rrggbb. */
export function normalizeColour(input?: string): string | null {
  if (!input) return null;
  const raw = input.trim().split(';')[0];
  if (cache.has(raw)) return cache.get(raw)!;
  let out: string | null = null;
  if (/^#?[0-9a-f]{6}$/i.test(raw)) out = '#' + raw.replace('#', '').toLowerCase();
  else if (/^#?[0-9a-f]{3}$/i.test(raw)) {
    const h = raw.replace('#', '');
    out = '#' + h.split('').map((c) => c + c).join('').toLowerCase();
  } else if (typeof document !== 'undefined') {
    ctx ??= document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = raw;
      const v = String(ctx.fillStyle);
      if (v !== '#010203' && /^#[0-9a-f]{6}$/i.test(v)) out = v.toLowerCase();
    }
  }
  cache.set(raw, out);
  return out;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableText(bg: string): string {
  return luminance(bg) > 0.42 ? '#0b1220' : '#ffffff';
}

/** Lifts very dark line colours so they stay visible on a night map. */
export function visibleOn(hex: string, dark: boolean): string {
  const L = luminance(hex);
  if (dark && L < 0.08) return mixHex(hex, '#ffffff', 0.45);
  if (!dark && L > 0.85) return mixHex(hex, '#000000', 0.35);
  return hex;
}

export function hexToGl(hex: string, a = 1): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255, a];
}
