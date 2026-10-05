import type { City, Line, RouteData, RunConfig } from '../types';
import { audio } from '../lib/audio/audio';
import { localHour, startInstant } from '../lib/env/sun';
import { fetchWeather } from '../lib/env/weather';
import { NetError } from '../lib/osm/http';
import { fetchRoute } from '../lib/osm/routeGeometry';
import { fetchStationInfra } from '../lib/osm/stationInfra';
import { loadGroundProfile } from '../lib/env/dem';
import { cacheSet } from '../lib/osm/cache';
import { fetchRoutesKind, groupLines, type CityRoutesProgress } from '../lib/osm/routes';
import type { RouteRef } from '../types';
import { driveSideFor, POPULAR, popularToCity } from '../lib/osm/search';
import { Engine } from '../lib/sim/engine';
import { PROFILES } from '../lib/sim/profiles';
import { mapCtl } from '../map/mapController';
import { setApp, useApp, type Screen } from '../store/app';
import { useHud } from '../store/hud';
import { useProgress } from '../store/progress';
import { useSettings } from '../store/settings';
import { applyEnv, landingEnv } from './env';
import { runner } from './runner';

let cityAbort: AbortController | null = null;
let routeAbort: AbortController | null = null;

function friendly(e: unknown): string {
  if (e instanceof NetError) {
    if (e.status === 408 || e.status === 504) return 'OpenStreetMap servers are busy right now. Give it another try in a moment.';
    if (e.status === 429) return 'Too many requests to OpenStreetMap. Wait a few seconds and retry.';
    return `Couldn’t reach OpenStreetMap (${e.message}).`;
  }
  if (e instanceof TypeError) return 'You seem to be offline. Cities you’ve opened before still work.';
  return (e as Error)?.message || 'Something went wrong.';
}

function progressMsg(p: CityRoutesProgress): string {
  if (p.stage === 'cache') return 'Checking saved routes…';
  if (p.stage === 'parse') return 'Building the network…';
  if (p.attempt && p.attempt > 0) return `Busy, trying another server (${p.host})…`;
  return 'Asking OpenStreetMap for every route…';
}

// ------------------------------------------------------------ navigation
let navigating = false;
function pushHistory(screen: Screen) {
  if (navigating) return;
  try {
    history.pushState({ screen }, '');
  } catch {
    /* ignore */
  }
}

let historyInit = false;
export function initHistory() {
  if (historyInit) return;
  historyInit = true;
  try {
    history.replaceState({ screen: 'home' }, '');
  } catch {
    /* ignore */
  }
  window.addEventListener('popstate', () => {
    const s = useApp.getState();
    if (s.searchOpen) {
      setApp({ searchOpen: false });
      return;
    }
    if (s.settingsOpen) {
      setApp({ settingsOpen: false });
      return;
    }
    if (s.screen === 'drive') {
      runner.pause(true);
      pushHistory('drive');
      return;
    }
    navigating = true;
    back();
    navigating = false;
  });
}

let homeCity: City | null = null;
export function homeEnv() {
  const recent = useProgress.getState().recentCities[0];
  homeCity ??= recent ?? popularToCity(POPULAR[Math.floor(Math.random() * POPULAR.length)]);
  const c = homeCity;
  landingEnv();
  return c;
}

export function goHome() {
  cityAbort?.abort();
  routeAbort?.abort();
  runner.stop();
  mapCtl.exitDrive();
  mapCtl.clearRoute();
  const c = useApp.getState().city ?? homeEnv();
  setApp({ screen: 'home', line: null, route: null, routeState: 'idle' });
  landingEnv();
  mapCtl.setInteractive(false);
  mapCtl.setLabels('minimal');
  mapCtl.startOrbit(c.lat, c.lon, { zoom: 15.2, pitch: 60, speed: 2.4 });
}

export function openAbout() {
  setApp({ screen: 'about' });
  pushHistory('about');
}

export function back() {
  const s = useApp.getState();
  switch (s.screen) {
    case 'about':
      setApp({ screen: 'home' });
      break;
    case 'route':
      closeRoute();
      break;
    case 'city':
      goHome();
      break;
    case 'results':
      runner.stop();
      mapCtl.exitDrive();
      setApp({ screen: 'route' });
      if (s.route) {
        mapCtl.showRoute(s.route, s.run.startIdx, s.run.endIdx);
        fitCurrent();
      }
      previewConditions();
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------ city
export async function openCity(city: City, force = false) {
  cityAbort?.abort();
  routeAbort?.abort();
  const ctrl = new AbortController();
  cityAbort = ctrl;
  setApp({
    screen: 'city',
    city,
    cityState: 'loading',
    cityError: undefined,
    lines: [],
    group: 'all',
    query: '',
    line: null,
    route: null,
    routeState: 'idle',
    searchOpen: false,
    loadingMsg: 'Finding transit routes…',
    weather: null,
  });
  pushHistory('city');
  useProgress.getState().addRecentCity(city);
  mapCtl.clearRoute();
  mapCtl.setInteractive(true);
  mapCtl.setLabels('full');
  mapCtl.startOrbit(city.lat, city.lon, { zoom: 12.4, pitch: 42, speed: 1.4 });
  applyEnv(Date.now(), city.lat, city.lon, 'clear');

  fetchWeather(city.lat, city.lon).then((w) => {
    if (useApp.getState().city?.id !== city.id) return;
    setApp({ weather: w });
    if (useApp.getState().screen === 'city') applyEnv(Date.now(), city.lat, city.lon, w.kind);
  });

  // rail and bus in parallel: rail shows up first, buses stream in after
  let rail: RouteRef[] | null = null;
  let bus: RouteRef[] | null = null;
  let railErr: unknown = null;
  setApp({ busState: 'loading', railState: 'loading' });
  const publish = () => {
    if (ctrl.signal.aborted) return;
    const refs = [...(rail ?? []), ...(bus ?? [])];
    setApp({ lines: groupLines(refs) });
  };
  const railP = fetchRoutesKind('rail', city, (p) => setApp({ loadingMsg: progressMsg(p) }), ctrl.signal, force)
    .then((r) => {
      rail = r;
      publish();
      if (!ctrl.signal.aborted) setApp({ cityState: 'ready', railState: 'ready' });
    })
    .catch((e) => {
      railErr = e;
      if ((e as Error).name !== 'AbortError' && !ctrl.signal.aborted) setApp({ railState: 'error' });
    });
  const busP = fetchRoutesKind('bus', city, undefined, ctrl.signal, force)
    .then((r) => {
      bus = r;
      publish();
      if (!ctrl.signal.aborted) setApp({ busState: 'ready' });
    })
    .catch((e) => {
      if ((e as Error).name !== 'AbortError' && !ctrl.signal.aborted) setApp({ busState: 'error' });
    });
  await railP;
  if (ctrl.signal.aborted) return;
  if (railErr) {
    // rail failed: wait for buses before deciding the city failed
    await busP;
    if (ctrl.signal.aborted) return;
    if (bus) setApp({ cityState: 'ready' });
    else if ((railErr as Error).name !== 'AbortError') setApp({ cityState: 'error', cityError: friendly(railErr) });
  }
}

export async function retryBuses() {
  const city = useApp.getState().city;
  if (!city) return;
  setApp({ busState: 'loading' });
  try {
    const bus = await fetchRoutesKind('bus', city, undefined, undefined, true);
    if (useApp.getState().city?.id !== city.id) return;
    const rail = useApp.getState().lines.filter((l) => l.group !== 'bus').flatMap((l) => l.variants);
    setApp({ lines: groupLines([...rail, ...bus]), busState: 'ready' });
  } catch {
    setApp({ busState: 'error' });
  }
}

export async function retryRail() {
  const city = useApp.getState().city;
  if (!city) return;
  setApp({ railState: 'loading' });
  try {
    const rail = await fetchRoutesKind('rail', city, undefined, undefined, true);
    if (useApp.getState().city?.id !== city.id) return;
    const bus = useApp.getState().lines.filter((l) => l.group === 'bus').flatMap((l) => l.variants);
    setApp({ lines: groupLines([...rail, ...bus]), railState: 'ready', cityState: 'ready' });
  } catch {
    setApp({ railState: 'error' });
  }
}

export function retryCity() {
  const c = useApp.getState().city;
  if (c) void openCity(c, true);
}

// ------------------------------------------------------------ route
function defaultEnd(route: RouteData): number {
  const n = route.stops.length;
  if (n <= 12) return n - 1;
  const p = PROFILES[route.mode];
  const maxLen = p.rail ? (route.mode === 'train' ? 16000 : 9000) : 5500;
  let end = 1;
  while (end < n - 1 && end < 9 && route.stops[end + 1].s - route.stops[0].s < maxLen) end++;
  return end;
}

export async function selectLine(line: Line, variantIdx = 0) {
  setApp({ screen: 'route', line, variantIdx, route: null, routeState: 'loading', routeError: undefined });
  pushHistory('route');
  mapCtl.stopOrbit();
  await loadVariant(line, variantIdx);
}

export async function selectVariant(i: number) {
  const line = useApp.getState().line;
  if (!line) return;
  setApp({ variantIdx: i, route: null, routeState: 'loading', routeError: undefined });
  await loadVariant(line, i);
}

async function loadVariant(line: Line, idx: number) {
  routeAbort?.abort();
  const ctrl = new AbortController();
  routeAbort = ctrl;
  const city = useApp.getState().city;
  try {
    const route = await fetchRoute(line.variants[idx], line, driveSideFor(city?.countryCode), ctrl.signal);
    if (ctrl.signal.aborted || useApp.getState().line !== line) return;
    const endIdx = defaultEnd(route);
    setApp({ route, routeState: 'ready', run: { ...useApp.getState().run, startIdx: 0, endIdx } });
    mapCtl.showRoute(route, 0, endIdx);
    void ensureGround(route);
    // station platforms/tracks stream in afterwards; the 3D scene picks them up when ready
    if (PROFILES[route.mode].rail && !route.infra) {
      void fetchStationInfra(route, ctrl.signal)
        .then((infra) => {
          if (infra) route.infra = infra;
        })
        .catch(() => {});
    }
    fitCurrent();
    previewConditions();
  } catch (e) {
    if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) return;
    setApp({ routeState: 'error', routeError: friendly(e) });
  }
}

export function fitCurrent() {
  const { route, run } = useApp.getState();
  if (!route) return;
  const h = window.innerHeight;
  const w = window.innerWidth;
  const wide = w > 900;
  mapCtl.fitRoute(route, run.startIdx, run.endIdx, {
    top: 90,
    bottom: wide ? 60 : Math.round(h * 0.55),
    left: wide ? 460 : 40,
    right: 40,
  });
}

export function closeRoute() {
  routeAbort?.abort();
  mapCtl.clearRoute();
  setApp({ screen: 'city', line: null, route: null, routeState: 'idle' });
  const c = useApp.getState().city;
  if (c) {
    mapCtl.startOrbit(c.lat, c.lon, { zoom: 12.4, pitch: 42, speed: 1.4 });
    applyEnv(Date.now(), c.lat, c.lon, useApp.getState().weather?.kind ?? 'clear');
  }
}

export function setRun(p: Partial<RunConfig>) {
  const s = useApp.getState();
  const run = { ...s.run, ...p };
  setApp({ run });
  if (s.route && (p.startIdx !== undefined || p.endIdx !== undefined)) {
    mapCtl.showRoute(s.route, run.startIdx, run.endIdx);
    fitCurrent();
  }
  if (p.time !== undefined || p.weather !== undefined) previewConditions();
}

export function previewConditions() {
  const { city, run, weather } = useApp.getState();
  if (!city) return;
  const off = weather?.utcOffset ?? Math.round(city.lon / 15) * 3600;
  const t = startInstant(run.time, city.lat, city.lon, off);
  const wk = run.weather === 'live' ? weather?.kind ?? 'clear' : run.weather;
  applyEnv(t, city.lat, city.lon, wk);
}

// ------------------------------------------------------------ terrain
const groundLoads = new Map<number, Promise<void>>();

/** Loads the terrain profile under a route once (cached); safe to call repeatedly. */
export function ensureGround(route: RouteData): Promise<void> {
  if (route.ground) return Promise.resolve();
  let p = groundLoads.get(route.id);
  if (!p) {
    p = loadGroundProfile(route)
      .then((g) => {
        if (g) {
          route.ground = g;
          void cacheSet(`route:v6:${route.id}`, route).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => groundLoads.delete(route.id));
    groundLoads.set(route.id, p);
  }
  return p;
}

// ------------------------------------------------------------ drive
export async function startRun() {
  const s = useApp.getState();
  const { route, run, city, line } = s;
  if (!route || !city || !line) return;
  const settings = useSettings.getState();
  audio.init();
  audio.setEnabled(settings.sound, settings.volume);
  audio.announcements = settings.announcements;
  try {
    if (matchMedia('(pointer: coarse)').matches && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  // the track profile must match the 3D ground before the vehicle is placed on it
  if (settings.terrain && settings.quality !== 'low' && !route.ground) {
    setApp({ loadingMsg: 'Loading terrain…' });
    await Promise.race([ensureGround(route), new Promise((ok) => setTimeout(ok, 8000))]);
    if (useApp.getState().route !== route) return;
  }
  const off = s.weather?.utcOffset ?? Math.round(city.lon / 15) * 3600;
  const wk = run.weather === 'live' ? s.weather?.kind ?? 'clear' : run.weather;
  const clock = startInstant(run.time, city.lat, city.lon, off);
  const engine = new Engine({
    route,
    startIdx: run.startIdx,
    endIdx: run.endIdx,
    clockStartUtc: clock,
    hourLocal: localHour(clock, off),
    weather: wk,
    autoDoors: settings.autoDoors,
    free: run.free,
  });
  mapCtl.showRoute(route, run.startIdx, run.endIdx);
  runner.start(engine, { city, line, startIdx: run.startIdx, endIdx: run.endIdx, utcOffset: off });
  setApp({ screen: 'drive', result: null });
  pushHistory('drive');
}

export function restartRun() {
  runner.stop();
  mapCtl.exitDrive();
  startRun();
}

export function quitRun() {
  runner.stop();
  mapCtl.exitDrive();
  useHud.setState({ paused: false });
  const s = useApp.getState();
  setApp({ screen: 'route' });
  if (s.route) {
    mapCtl.showRoute(s.route, s.run.startIdx, s.run.endIdx);
    fitCurrent();
  }
  previewConditions();
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

export function reverseRun() {
  const s = useApp.getState();
  const line = s.line;
  const route = s.route;
  if (!line || !route) return;
  // find the variant that runs the other way
  const other = line.variants.findIndex(
    (v, i) => i !== s.variantIdx && (v.from === route.to || v.to === route.from || (line.variants.length === 2 && i !== s.variantIdx)),
  );
  runner.stop();
  mapCtl.exitDrive();
  if (other >= 0) {
    setApp({ screen: 'route' });
    void selectVariant(other);
  } else back();
}
