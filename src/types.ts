export type Mode =
  | 'subway'
  | 'train'
  | 'light_rail'
  | 'tram'
  | 'monorail'
  | 'bus'
  | 'trolleybus'
  | 'ferry';

export type ModeGroup = 'metro' | 'train' | 'tram' | 'monorail' | 'bus' | 'ferry';

export interface City {
  id: string;
  name: string;
  region?: string;
  country?: string;
  countryCode?: string;
  lat: number;
  lon: number;
  /** west, south, east, north */
  bbox: [number, number, number, number];
}

export interface RouteRef {
  id: number;
  mode: Mode;
  ref?: string;
  name?: string;
  from?: string;
  to?: string;
  via?: string;
  colour?: string;
  network?: string;
  operator?: string;
  longDistance?: boolean;
  /** a railway-line relation rather than a passenger service */
  railLine?: boolean;
}

export interface Line {
  key: string;
  mode: Mode;
  group: ModeGroup;
  ref: string;
  name: string;
  colour: string;
  textColour: string;
  network?: string;
  longDistance?: boolean;
  railLine?: boolean;
  variants: RouteRef[];
}

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** distance along path (m) of the stop marker */
  s: number;
  /** platform side relative to travel direction: -1 left, 1 right */
  side: -1 | 1;
}

export interface WaySpan {
  s0: number;
  s1: number;
  tunnel: boolean;
  bridge: boolean;
  /** m/s */
  maxspeed?: number;
}

export interface RouteData {
  id: number;
  mode: Mode;
  ref: string;
  name: string;
  from?: string;
  to?: string;
  network?: string;
  colour: string;
  textColour: string;
  lat: number[];
  lon: number[];
  stops: Stop[];
  ways: WaySpan[];
  /** geometry was reconstructed (no way members) */
  approx?: boolean;
  /** stops were not mapped, halts were spaced evenly along the route */
  synthStops?: boolean;
  /** real platforms and neighbouring tracks around stations (loaded in the background) */
  infra?: StationInfra;
  /** terrain height along the route every `step` metres (loaded in the background) */
  ground?: { step: number; z: number[] };
  driveSide: -1 | 1;
  bounds: [number, number, number, number];
  fetchedAt: number;
}

export interface StationInfra {
  platforms: { pts: [number, number][]; area: boolean }[];
  tracks: [number, number][][];
}

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'rain' | 'storm' | 'snow';

export interface WeatherInfo {
  kind: WeatherKind;
  temp: number;
  wind: number;
  utcOffset: number;
  timezone?: string;
}

export type TimeChoice = 'live' | 'dawn' | 'day' | 'dusk' | 'night';
export type WeatherChoice = 'live' | WeatherKind;
export type CameraMode = 'chase' | 'cab' | 'top';

export interface RunConfig {
  startIdx: number;
  endIdx: number;
  time: TimeChoice;
  weather: WeatherChoice;
  free: boolean;
}

export interface StopRating {
  name: string;
  error: number;
  grade: 'perfect' | 'great' | 'good' | 'ok' | 'missed';
  delay: number;
  points: number;
}

export interface RunResult {
  routeKey: string;
  cityName: string;
  lineRef: string;
  lineName: string;
  colour: string;
  mode: Mode;
  score: number;
  maxScore: number;
  stars: number;
  distance: number;
  duration: number;
  stops: StopRating[];
  paxDelivered: number;
  comfort: number;
  overspeedTime: number;
  atpCount: number;
  onTime: number;
  perfect: number;
  breakdown: { label: string; points: number }[];
  date: number;
  best: boolean;
  free?: boolean;
  maxSpeed?: number;
  bestStreak?: number;
}
