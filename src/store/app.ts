import { create } from 'zustand';
import type { City, Line, ModeGroup, RouteData, RunConfig, RunResult, WeatherInfo } from '../types';

export type Screen = 'home' | 'about' | 'city' | 'route' | 'drive' | 'results';

export interface AppState {
  screen: Screen;
  prevScreen: Screen;
  city: City | null;
  cityState: 'idle' | 'loading' | 'ready' | 'error';
  cityError?: string;
  loadingMsg: string;
  busState: 'idle' | 'loading' | 'ready' | 'error';
  lines: Line[];
  weather: WeatherInfo | null;
  group: ModeGroup | 'all';
  query: string;
  line: Line | null;
  variantIdx: number;
  route: RouteData | null;
  routeState: 'idle' | 'loading' | 'ready' | 'error';
  routeError?: string;
  run: RunConfig;
  result: RunResult | null;
  uiDark: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  /** map style loaded (drives the splash screen) */
  mapReady: boolean;
  mapError?: string;
  /** snap index shared by the city and route sheets so switching feels like one sheet */
  sheetSnap: number;
  online: boolean;
  installable: boolean;
}

export const useApp = create<AppState>()(() => ({
  screen: 'home',
  prevScreen: 'home',
  city: null,
  cityState: 'idle',
  loadingMsg: '',
  busState: 'idle',
  lines: [],
  weather: null,
  group: 'all',
  query: '',
  line: null,
  variantIdx: 0,
  route: null,
  routeState: 'idle',
  run: { startIdx: 0, endIdx: 0, time: 'live', weather: 'live', free: false },
  result: null,
  uiDark: true,
  searchOpen: false,
  settingsOpen: false,
  mapReady: false,
  sheetSnap: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  installable: false,
}));

export const setApp = (p: Partial<AppState>) => {
  const cur = useApp.getState();
  if (p.screen && p.screen !== cur.screen) p = { ...p, prevScreen: cur.screen };
  useApp.setState(p);
};
