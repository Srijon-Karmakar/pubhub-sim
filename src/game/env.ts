import type { WeatherKind } from '../types';
import { sunAt } from '../lib/env/sun';
import { mapCtl } from '../map/mapController';
import { setApp, useApp } from '../store/app';
import { useSettings } from '../store/settings';

let lastAlt: number | undefined;

export function computeDark(alt = lastAlt): boolean {
  const pref = useSettings.getState().theme;
  if (pref === 'light') return false;
  if (pref === 'dark') return true;
  const sys = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  if (pref === 'system' || alt === undefined) return sys;
  return alt < -1;
}

export function syncTheme(alt = lastAlt) {
  const dark = computeDark(alt);
  if (useApp.getState().uiDark !== dark) setApp({ uiDark: dark });
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', dark ? '#0b1020' : '#f4f5f7');
}

/** Lights the world (map palette, sky, 3D shading, UI theme) for an instant at a place. */
export function applyEnv(utcMs: number, lat: number, lon: number, weather: WeatherKind) {
  const sun = sunAt(utcMs, lat, lon);
  lastAlt = sun.altitude;
  mapCtl.setEnvironment(sun.altitude, sun.bearing, weather);
  syncTheme(sun.altitude);
  return sun;
}
