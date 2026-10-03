import type { WeatherKind } from '../../types';
import { hexToRgb, luminance, mixHex, rgbToHex } from '../color';
import { clamp } from '../geo';

export interface Palette {
  bg: string;
  residential: string;
  industrial: string;
  park: string;
  wood: string;
  grass: string;
  sand: string;
  water: string;
  waterLine: string;
  building: string;
  buildingTop: string;
  roadMinor: string;
  roadMinorCase: string;
  roadMajor: string;
  roadMajorCase: string;
  motorway: string;
  motorwayCase: string;
  service: string;
  path: string;
  rail: string;
  runway: string;
  label: string;
  labelMinor: string;
  labelHalo: string;
  waterLabel: string;
  boundary: string;
  sky: string;
  horizon: string;
  fog: string;
  light: string;
  lightIntensity: number;
  fogBlend: number;
}

const DAY: Palette = {
  bg: '#f3f1ec',
  residential: '#eeebe5',
  industrial: '#ebe6e0',
  park: '#d2eac4',
  wood: '#c3e1b2',
  grass: '#dbeecd',
  sand: '#f2e8cf',
  water: '#9fd0f0',
  waterLine: '#8bc3e8',
  building: '#e2ded7',
  buildingTop: '#ece8e2',
  roadMinor: '#ffffff',
  roadMinorCase: '#dcd8d2',
  roadMajor: '#ffffff',
  roadMajorCase: '#d0cbc3',
  motorway: '#ffdf9e',
  motorwayCase: '#e6b45f',
  service: '#faf9f6',
  path: '#d2ccc3',
  rail: '#b3aea6',
  runway: '#dbd8d3',
  label: '#353c4a',
  labelMinor: '#697180',
  labelHalo: '#ffffff',
  waterLabel: '#3f78a3',
  boundary: '#b39ddb',
  sky: '#7fb8f0',
  horizon: '#e6f1ff',
  fog: '#e6f1ff',
  light: '#ffffff',
  lightIntensity: 0.32,
  fogBlend: 0.5,
};

const GOLDEN: Palette = {
  bg: '#f1e1cc',
  residential: '#eedac3',
  industrial: '#e9d5c0',
  park: '#d2dcaa',
  wood: '#c2d199',
  grass: '#d8dfb0',
  sand: '#f0dab5',
  water: '#98bcd4',
  waterLine: '#86abc9',
  building: '#e6cdb0',
  buildingTop: '#f2d8b6',
  roadMinor: '#fff3e2',
  roadMinorCase: '#dac1a2',
  roadMajor: '#fff0d8',
  roadMajorCase: '#d4b58b',
  motorway: '#ffcf86',
  motorwayCase: '#d79e4c',
  service: '#fbefdf',
  path: '#d3bfa4',
  rail: '#b6a28b',
  runway: '#dfcbb3',
  label: '#56422f',
  labelMinor: '#7b6350',
  labelHalo: '#fff5e8',
  waterLabel: '#557b99',
  boundary: '#c49bc0',
  sky: '#f0a265',
  horizon: '#ffd49c',
  fog: '#ffcf98',
  light: '#ffcf9a',
  lightIntensity: 0.45,
  fogBlend: 0.5,
};

const DUSK: Palette = {
  bg: '#33334e',
  residential: '#373653',
  industrial: '#383751',
  park: '#303f48',
  wood: '#2c3b44',
  grass: '#33414a',
  sand: '#47425c',
  water: '#23335a',
  waterLine: '#2a3c68',
  building: '#423f5c',
  buildingTop: '#4e4a6b',
  roadMinor: '#524e6f',
  roadMinorCase: '#2b2941',
  roadMajor: '#676185',
  roadMajorCase: '#312e49',
  motorway: '#87708d',
  motorwayCase: '#3a324d',
  service: '#474462',
  path: '#474462',
  rail: '#686385',
  runway: '#494665',
  label: '#e6e1f6',
  labelMinor: '#b6b0cf',
  labelHalo: '#28263d',
  waterLabel: '#9ab1e4',
  boundary: '#9a83c6',
  sky: '#2a2e62',
  horizon: '#bd6f88',
  fog: '#8a5c7e',
  light: '#d0b0e4',
  lightIntensity: 0.3,
  fogBlend: 0.45,
};

const NIGHT: Palette = {
  bg: '#0d121e',
  residential: '#101625',
  industrial: '#111726',
  park: '#0e1c1b',
  wood: '#0c1a18',
  grass: '#0f1d1c',
  sand: '#191c26',
  water: '#07182b',
  waterLine: '#0a203c',
  building: '#182030',
  buildingTop: '#1f293c',
  roadMinor: '#222b3e',
  roadMinorCase: '#111726',
  roadMajor: '#2e3950',
  roadMajorCase: '#131a2a',
  motorway: '#4a4431',
  motorwayCase: '#191918',
  service: '#1d2535',
  path: '#1e2636',
  rail: '#384357',
  runway: '#1b2232',
  label: '#a8b3c8',
  labelMinor: '#7a859b',
  labelHalo: '#0a0e17',
  waterLabel: '#5d82b1',
  boundary: '#5a4e85',
  sky: '#02050d',
  horizon: '#15203a',
  fog: '#0f182c',
  light: '#9cb0ff',
  lightIntensity: 0.2,
  fogBlend: 0.4,
};

function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const out = {} as Record<string, string | number>;
  for (const k of Object.keys(a) as (keyof Palette)[]) {
    const va = a[k];
    const vb = b[k];
    out[k] = typeof va === 'number' ? va + ((vb as number) - va) * t : mixHex(va, vb as string, t);
  }
  return out as unknown as Palette;
}

/** Map palette for a given sun altitude (degrees). */
export function paletteForSun(alt: number): Palette {
  if (alt >= 12) return DAY;
  if (alt >= 3) return mixPalette(GOLDEN, DAY, (alt - 3) / 9);
  if (alt >= -4) return mixPalette(DUSK, GOLDEN, (alt + 4) / 7);
  if (alt >= -10) return mixPalette(NIGHT, DUSK, (alt + 10) / 6);
  return NIGHT;
}

/** 0 = full day, 1 = full night. */
export function nightness(alt: number): number {
  return clamp((4 - alt) / 14, 0, 1);
}

function desaturate(hex: string, amt: number, darken: number): string {
  const L = luminance(hex);
  const g = Math.round(Math.pow(L, 1 / 2.2) * 255);
  const grey = rgbToHex([g, g, g]);
  const m = mixHex(hex, grey, amt);
  const [r, gg, b] = hexToRgb(m);
  return rgbToHex([r * (1 - darken), gg * (1 - darken), b * (1 - darken)]);
}

export function applyWeather(p: Palette, w: WeatherKind, night: number): Palette {
  if (w === 'clear') return p;
  const out = { ...p } as Record<string, string | number>;
  const amt = w === 'cloudy' ? 0.22 : w === 'fog' ? 0.4 : w === 'snow' ? 0.3 : w === 'rain' ? 0.38 : 0.5;
  const dk = w === 'storm' ? 0.18 : w === 'rain' ? 0.08 : 0.02;
  for (const k of Object.keys(p) as (keyof Palette)[]) {
    const v = p[k];
    if (typeof v === 'string' && k !== 'label' && k !== 'labelHalo') out[k] = desaturate(v, amt, dk * (1 - night * 0.6));
  }
  if (w === 'snow') {
    const snow = night > 0.5 ? '#2c3445' : '#f5f8fc';
    for (const k of ['bg', 'residential', 'industrial', 'park', 'wood', 'grass', 'sand', 'building', 'buildingTop'] as const) {
      out[k] = mixHex(out[k] as string, snow, 0.55);
    }
  }
  if (w === 'fog' || w === 'storm' || w === 'rain') {
    const fogc = night > 0.5 ? '#1f2636' : '#c9ced6';
    out.fog = fogc;
    out.horizon = mixHex(out.horizon as string, fogc, 0.7);
    out.sky = mixHex(out.sky as string, fogc, w === 'fog' ? 0.85 : 0.6);
    out.fogBlend = w === 'fog' ? 0.12 : 0.3;
  }
  out.lightIntensity = (p.lightIntensity as number) * 0.8;
  return out as unknown as Palette;
}

/** Brightens a (night) palette so the city stays readable as a backdrop. */
export function liftPalette(p: Palette, amt: number): Palette {
  if (amt <= 0) return p;
  const out = { ...p } as Record<string, string | number>;
  const lift: [keyof Palette, number][] = [
    ['bg', 0.6],
    ['residential', 0.6],
    ['industrial', 0.6],
    ['building', 1.3],
    ['buildingTop', 1.5],
    ['roadMinor', 1.4],
    ['roadMajor', 1.7],
    ['motorway', 1.4],
    ['service', 1.1],
    ['path', 1],
    ['rail', 1.4],
    ['water', 0.9],
    ['waterLine', 0.9],
    ['park', 0.9],
    ['wood', 0.9],
    ['grass', 0.9],
  ];
  for (const [k, w] of lift) out[k] = mixHex(p[k] as string, '#a9b8d0', Math.min(0.85, amt * w));
  out.label = mixHex(p.label, '#ffffff', amt);
  return out as unknown as Palette;
}
