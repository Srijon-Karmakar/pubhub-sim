import type { WeatherKind } from '../types';
import { sunAt } from '../lib/env/sun';
import { mapCtl } from '../map/mapController';
import { setApp, useApp } from '../store/app';
import { useSettings } from '../store/settings';

let lastAlt: number | undefined;

/** The landing screens always use the dark look; the game follows the player's settings. */
const onLanding = () => {
  const s = useApp.getState().screen;
  return s === 'home' || s === 'about';
};

export function computeDark(alt = lastAlt): boolean {
  const pref = useSettings.getState().theme;
  // landing is dark unless the player explicitly picked Light
  if (onLanding()) return pref !== 'light';
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
  meta?.setAttribute('content', dark ? '#0a0d04' : '#f4f5f7');
}

/** Landing backdrop: a lifted night map, or a daytime map when the player chose Light. */
export function landingEnv() {
  if (useSettings.getState().theme === 'light') mapCtl.setEnvironment(40, Math.PI * 0.8, 'clear');
  else mapCtl.setEnvironment(-30, Math.PI, 'clear', 0.22);
  syncTheme();
}

/** Re-apply the theme after a settings change (landing screens repaint the map too). */
export function refreshTheme() {
  if (onLanding()) landingEnv();
  else syncTheme();
}

/** Lights the world (map palette, sky, 3D shading, UI theme) for an instant at a place. */
export function applyEnv(utcMs: number, lat: number, lon: number, weather: WeatherKind) {
  const sun = sunAt(utcMs, lat, lon);
  lastAlt = sun.altitude;
  mapCtl.setEnvironment(sun.altitude, sun.bearing, weather);
  syncTheme(sun.altitude);
  return sun;
}
