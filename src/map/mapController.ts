import { LngLat, Map as MlMap, setWorkerUrl, type GeoJSONSource, type LayerSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection } from 'geojson';
import type { CameraMode, RouteData, WeatherKind } from '../types';
import { visibleOn } from '../lib/color';
import { applyWeather, liftPalette, nightness, paletteForSun, type Palette } from '../lib/env/palette';
import { angleDiff, clamp, lerp } from '../lib/geo';
import type { Engine } from '../lib/sim/engine';
import { SceneLayer } from './sceneLayer';
import { buildLayers, buildStyle, skyFor } from './style';

const DEG = 180 / Math.PI;

// MapLibre v6 resolves its worker relative to its own module, which bundlers relocate.
setWorkerUrl(workerUrl);

interface CamSnap {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

class MapController {
  map: MlMap | null = null;
  readonly scene = new SceneLayer();
  private palette: Palette = paletteForSun(30);
  private applied = new Map<string, string>();
  private orbitRaf = 0;
  private orbitPaused = false;
  private buildingOpacity = 0.94;
  private readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  private routeColour = '#3b82f6';
  private dark = false;

  // drive camera state
  following = false;
  freeCam = false;
  onFreeCamChange?: (free: boolean) => void;
  private camBearing = 0;
  private zoomOffset = 0;
  private blend = 1;
  private blendDur = 0.9;
  private blendFrom: CamSnap | null = null;
  private pinch: { d: number; z: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();

  /** Returns false when WebGL is unavailable. */
  init(container: HTMLElement, lat: number, lon: number): boolean {
    if (this.map) return true;
    let map: MlMap;
    try {
      map = new MlMap({
      container,
      style: buildStyle(this.palette),
      center: [lon, lat],
      zoom: 14.6,
      pitch: 58,
      bearing: -20,
      maxPitch: 85,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      fadeDuration: 150,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    } catch (e) {
      console.error(e);
      return false;
    }
    this.map = map;
    map.on('load', () => {
      map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      map.addLayer(this.scene);
      this.readyResolve();
    });
    map.on('dragstart', (e) => {
      if (this.following && (e as { originalEvent?: Event }).originalEvent && this.pointers.size < 2) this.setFree(true);
      this.orbitPaused = true;
    });
    map.on('touchstart', () => (this.orbitPaused = true));
    map.on('wheel', () => (this.orbitPaused = true));

    const el = map.getCanvasContainer();
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.following || this.freeCam) return;
        e.preventDefault();
        this.zoomOffset = clamp(this.zoomOffset - e.deltaY * 0.0025, -3.5, 2);
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2 && this.following && !this.freeCam) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.zoomOffset };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomOffset = clamp(this.pinch.z + Math.log2(d / Math.max(1, this.pinch.d)), -3.5, 2);
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return true;
  }

  /** Cinematic backgrounds read better without street-level labels. */
  setLabels(mode: 'minimal' | 'full') {
    const map = this.map;
    if (!map) return;
    const apply = () => {
      for (const id of ['road-name', 'place-minor', 'water-name', 'place-town', 'place-city']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', mode === 'minimal' ? 'none' : 'visible');
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }

  // ------------------------------------------------------------ environment
  setEnvironment(sunAlt: number, sunBearing: number, weather: WeatherKind, lift = 0) {
    const night = nightness(sunAlt);
    const p = liftPalette(applyWeather(paletteForSun(sunAlt), weather, night), lift);
    this.palette = p;
    this.dark = night > 0.55;
    this.scene.night = night;
    // light direction for our 3D layer (ENU)
    const alt = Math.max(sunAlt, 25) / DEG;
    const b = sunAlt > -2 ? sunBearing : sunBearing + Math.PI;
    this.scene.sun = [Math.sin(b) * Math.cos(alt), Math.cos(b) * Math.cos(alt), Math.sin(alt)];
    this.applyPalette();
    const map = this.map;
    if (!map || !map.isStyleLoaded()) return;
    map.setSky(skyFor(p));
    const polar = clamp(90 - Math.max(sunAlt, 15), 15, 75);
    map.setLight({ anchor: 'map', color: p.light, intensity: p.lightIntensity, position: [1.4, ((b * DEG) % 360 + 360) % 360, polar] });
    if (map.getLayer('route-line') && this.routeDark !== this.dark) this.setRouteColour(this.routeColour);
  }

  private routeDark: boolean | null = null;

  /** Battery saver: 1x pixel ratio and flat buildings. */
  setQuality(q: 'high' | 'low') {
    const map = this.map;
    if (!map) return;
    map.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    const apply = () => map.getLayer('building-3d') && map.setLayoutProperty('building-3d', 'visibility', q === 'low' ? 'none' : 'visible');
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }

  get isDark() {
    return this.dark;
  }

  private applyPalette() {
    const map = this.map;
    if (!map || !map.isStyleLoaded()) {
      this.map?.once('load', () => this.applyPalette());
      return;
    }
    for (const layer of buildLayers(this.palette, this.buildingOpacity) as (LayerSpecification & { paint?: Record<string, unknown> })[]) {
      if (!layer.paint || !map.getLayer(layer.id)) continue;
      for (const [k, v] of Object.entries(layer.paint)) {
        const key = `${layer.id}|${k}`;
        const json = JSON.stringify(v);
        if (this.applied.get(key) === json) continue;
        this.applied.set(key, json);
        map.setPaintProperty(layer.id, k as never, v as never);
      }
    }
  }

  setBuildingOpacity(o: number) {
    if (Math.abs(o - this.buildingOpacity) < 0.01) return;
    this.buildingOpacity = o;
    this.applyPalette();
  }

  // ------------------------------------------------------------ orbit / flights
  startOrbit(lat: number, lon: number, opts: { zoom?: number; pitch?: number; speed?: number; fly?: boolean } = {}) {
    const map = this.map;
    if (!map) return;
    this.stopOrbit();
    this.orbitPaused = false;
    const zoom = opts.zoom ?? 15;
    const pitch = opts.pitch ?? 58;
    const speed = opts.speed ?? 2.2;
    const begin = () => {
      let last = performance.now();
      const tick = (t: number) => {
        const dt = Math.min(0.1, (t - last) / 1000);
        last = t;
        if (!this.orbitPaused && !map.isMoving()) map.setBearing(map.getBearing() + speed * dt);
        this.orbitRaf = requestAnimationFrame(tick);
      };
      this.orbitRaf = requestAnimationFrame(tick);
    };
    if (opts.fly === false) {
      map.jumpTo({ center: [lon, lat], zoom, pitch });
      begin();
    } else {
      map.flyTo({ center: [lon, lat], zoom, pitch, bearing: map.getBearing() + 20, duration: 2600, essential: true, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      map.once('moveend', begin);
    }
  }

  stopOrbit() {
    if (this.orbitRaf) cancelAnimationFrame(this.orbitRaf);
    this.orbitRaf = 0;
  }

  setInteractive(on: boolean) {
    const map = this.map;
    if (!map) return;
    const hs = [map.dragPan, map.scrollZoom, map.boxZoom, map.dragRotate, map.keyboard, map.doubleClickZoom, map.touchZoomRotate, map.touchPitch];
    for (const h of hs) {
      if (on) h.enable();
      else h.disable();
    }
  }

  fitRoute(route: RouteData, startIdx: number, endIdx: number, padding: { top: number; bottom: number; left: number; right: number }) {
    const map = this.map;
    if (!map) return;
    const a = route.stops[startIdx].s;
    const b = route.stops[endIdx].s;
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    // sample along the selected range
    let cum = 0;
    for (let i = 0; i < route.lat.length; i++) {
      if (i > 0) {
        const dy = (route.lat[i] - route.lat[i - 1]) * 111320;
        const dx = (route.lon[i] - route.lon[i - 1]) * 111320 * Math.cos((route.lat[i] * Math.PI) / 180);
        cum += Math.hypot(dx, dy);
      }
      if (cum < a - 50 || cum > b + 50) continue;
      w = Math.min(w, route.lon[i]);
      e = Math.max(e, route.lon[i]);
      s = Math.min(s, route.lat[i]);
      n = Math.max(n, route.lat[i]);
    }
    if (!isFinite(w)) [w, s, e, n] = route.bounds;
    this.stopOrbit();
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding, pitch: 30, bearing: 0, duration: 1400, maxZoom: 16.5, essential: true },
    );
  }

  // ------------------------------------------------------------ route layers
  showRoute(route: RouteData, startIdx: number, endIdx: number) {
    const map = this.map;
    if (!map) return;
    this.routeColour = route.colour;
    const line: Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: route.lat.map((la, i) => [route.lon[i], la]) },
    };
    const stops = this.stopsGeo(route, startIdx, endIdx, -1, false);
    const rs = map.getSource('route') as GeoJSONSource | undefined;
    if (rs) {
      rs.setData(line);
      (map.getSource('route-stops') as GeoJSONSource).setData(stops);
    } else {
      map.addSource('route', { type: 'geojson', data: line, lineMetrics: true });
      map.addSource('route-stops', { type: 'geojson', data: stops });
      const before = map.getLayer('boundary') ? 'boundary' : undefined;
      map.addLayer(
        {
          id: 'route-glow',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': route.colour, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 22], 'line-blur': 10, 'line-opacity': 0.35 },
        },
        before,
      );
      map.addLayer(
        {
          id: 'route-casing',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 16, 9], 'line-opacity': 0.9 },
        },
        before,
      );
      map.addLayer(
        {
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.6, 16, 5.5], 'line-color': route.colour },
        },
        before,
      );
      map.addLayer({
        id: 'stops-circle',
        type: 'circle',
        source: 'route-stops',
        paint: {
          'circle-radius': ['match', ['get', 'state'], 'off', 3, 'next', 8, ['case', ['get', 'terminal'], 7, 5.5]],
          'circle-color': ['match', ['get', 'state'], 'next', route.colour, '#ffffff'],
          'circle-stroke-color': ['match', ['get', 'state'], 'off', '#9aa3b2', 'done', '#9aa3b2', route.colour],
          'circle-stroke-width': ['match', ['get', 'state'], 'off', 1.5, 'next', 3.5, 3],
          'circle-opacity': ['match', ['get', 'state'], 'off', 0.6, 1],
          'circle-stroke-opacity': ['match', ['get', 'state'], 'off', 0.6, 1],
          'circle-pitch-alignment': 'map',
        },
      });
      map.addLayer({
        id: 'stops-label',
        type: 'symbol',
        source: 'route-stops',
        filter: ['!=', ['get', 'state'], 'off'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['match', ['get', 'state'], 'next', 14, 12],
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-max-width': 9,
          'text-optional': true,
          'symbol-sort-key': ['match', ['get', 'state'], 'next', 0, 1],
        },
        paint: { 'text-color': this.dark ? '#f4f6fb' : '#1d2433', 'text-halo-color': this.dark ? '#0b0f18' : '#ffffff', 'text-halo-width': 1.6 },
      });
      // keep the 3D scene on top
      if (map.getLayer('scene')) map.moveLayer('scene');
    }
    this.setRouteColour(route.colour);
    this.setRouteProgress(0, route.stops[startIdx].s / Math.max(1, this.routeLen(route)), route.stops[endIdx].s / Math.max(1, this.routeLen(route)));
  }

  private routeLen(route: RouteData) {
    let L = 0;
    for (let i = 1; i < route.lat.length; i++) {
      const dy = (route.lat[i] - route.lat[i - 1]) * 111320;
      const dx = (route.lon[i] - route.lon[i - 1]) * 111320 * Math.cos((route.lat[i] * Math.PI) / 180);
      L += Math.hypot(dx, dy);
    }
    return L;
  }

  private stopsGeo(route: RouteData, startIdx: number, endIdx: number, nextIdx: number, servedNext: boolean): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: route.stops.map((s, i) => {
        let state = 'future';
        if (i < startIdx || i > endIdx) state = 'off';
        else if (nextIdx >= 0 && i < nextIdx) state = 'done';
        else if (i === nextIdx) state = servedNext ? 'done' : 'next';
        return {
          type: 'Feature',
          properties: { name: s.name, state, terminal: i === startIdx || i === endIdx },
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        };
      }),
    };
  }

  updateStops(route: RouteData, startIdx: number, endIdx: number, nextIdx: number, served: boolean) {
    const src = this.map?.getSource('route-stops') as GeoJSONSource | undefined;
    src?.setData(this.stopsGeo(route, startIdx, endIdx, nextIdx, served));
  }

  setRouteColour(c: string) {
    const map = this.map;
    if (!map || !map.getLayer('route-line')) return;
    this.routeDark = this.dark;
    const col = visibleOn(c, this.dark);
    map.setPaintProperty('route-glow', 'line-color', col);
    map.setPaintProperty('route-casing', 'line-color', this.dark ? '#0b0f18' : '#ffffff');
    map.setPaintProperty('stops-circle', 'circle-color', ['match', ['get', 'state'], 'next', col, this.dark ? '#0f1524' : '#ffffff']);
    map.setPaintProperty('stops-circle', 'circle-stroke-color', ['match', ['get', 'state'], 'off', '#7d8699', 'done', '#7d8699', col]);
    map.setPaintProperty('stops-label', 'text-color', this.dark ? '#f4f6fb' : '#1d2433');
    map.setPaintProperty('stops-label', 'text-halo-color', this.dark ? '#0b0f18' : '#ffffff');
    this.lastProgress = '';
    this.setRouteProgress(this.prog[0], this.prog[1], this.prog[2]);
  }

  private prog: [number, number, number] = [0, 0, 1];
  private lastProgress = '';
  /** Colours the line: dim outside [a,b], "done" part greyed up to `done`. */
  setRouteProgress(done: number, a: number, b: number) {
    this.prog = [done, a, b];
    const map = this.map;
    if (!map || !map.getLayer('route-line')) return;
    const col = visibleOn(this.routeColour, this.dark);
    const off = this.dark ? '#3a4356' : '#b9bfca';
    const doneC = this.dark ? '#5b6477' : '#9aa1ad';
    const stops: (number | string)[] = [];
    const push = (pos: number, c: string) => {
      const p = clamp(pos, 0, 1);
      if (stops.length && p <= (stops[stops.length - 2] as number)) return;
      stops.push(p, c);
    };
    const A = clamp(a, 0, 1);
    const B = clamp(b, 0, 1);
    const D = clamp(Math.max(done, A), A, B);
    push(A, D > A ? doneC : col);
    if (D > A) push(D, col);
    push(B, off);
    const expr = ['step', ['line-progress'], off, ...stops];
    const json = JSON.stringify(expr);
    if (json === this.lastProgress) return;
    this.lastProgress = json;
    map.setPaintProperty('route-line', 'line-gradient', expr as never);
  }

  clearRoute() {
    const map = this.map;
    if (!map) return;
    for (const id of ['stops-label', 'stops-circle', 'route-line', 'route-casing', 'route-glow']) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ['route', 'route-stops']) if (map.getSource(id)) map.removeSource(id);
  }

  // ------------------------------------------------------------ drive camera
  enterDrive(engine: Engine, colour: string, driveSide: -1 | 1, intro = false) {
    this.stopOrbit();
    this.following = true;
    this.freeCam = false;
    this.zoomOffset = 0;
    this.blend = 0;
    this.blendDur = intro ? 3.2 : 0.9;
    this.blendFrom = this.snap();
    this.camBearing = engine.track.path.headingAt(engine.s + 15);
    this.scene.setRun(engine, colour, driveSide);
    const map = this.map;
    if (!map) return;
    map.dragRotate.disable();
    map.scrollZoom.disable();
    map.touchZoomRotate.disable();
    map.touchPitch.disable();
    map.doubleClickZoom.disable();
    map.dragPan.enable();
  }

  exitDrive() {
    this.following = false;
    this.freeCam = false;
    this.scene.setRun(null, '#000', 1);
    this.setBuildingOpacity(0.94);
    this.scene.xray = false;
    const map = this.map;
    if (!map) return;
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    this.setInteractive(true);
  }

  private snap(): CamSnap | null {
    const map = this.map;
    if (!map) return null;
    const c = map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  }

  setFree(free: boolean) {
    if (this.freeCam === free) return;
    this.freeCam = free;
    const map = this.map;
    if (map) {
      if (free) {
        map.scrollZoom.enable();
        map.touchZoomRotate.enable();
        map.dragRotate.enable();
        map.touchPitch.enable();
      } else {
        map.scrollZoom.disable();
        map.touchZoomRotate.disable();
        map.dragRotate.disable();
        map.touchPitch.disable();
        this.blend = 0;
        this.blendDur = 0.9;
        this.blendFrom = this.snap();
      }
    }
    this.onFreeCamChange?.(free);
  }

  resetZoom() {
    this.zoomOffset = 0;
  }

  /** Called every frame while driving. */
  follow(engine: Engine, mode: CameraMode, dt: number, headingUp: boolean) {
    const map = this.map;
    if (!map || !this.following || this.freeCam) return;
    const tr = engine.track;
    const p = engine.profile;
    const L = engine.length;
    const h = map.getContainer().clientHeight;
    const isBus = !p.rail && p.sound !== 'ship';
    const lookAhead = mode === 'top' ? 25 : 18;
    const targetB = tr.path.headingAt(engine.s + lookAhead, 14) * DEG;
    const k = 1 - Math.exp(-dt * (mode === 'cab' ? 7 : 2.6));
    this.camBearing = this.camBearing + angleDiff(this.camBearing / DEG, targetB / DEG) * DEG * k;
    let target: CamSnap;
    let padding = { top: 0, bottom: 0, left: 0, right: 0 };
    if (mode === 'cab') {
      const s = engine.s - (isBus ? 2.2 : p.sound === 'ship' ? L * 0.35 : 1.6);
      const [la, lo] = tr.path.pointAt(s);
      // driver sits away from the kerb on road vehicles
      const lat = isBus ? engine.route.driveSide * 1.0 : 0;
      const hd = tr.path.headingAt(s, 6);
      const camLat = la + (-Math.sin(hd) * lat) / 111320;
      const camLon = lo + (Math.cos(hd) * lat) / (111320 * Math.cos((la * Math.PI) / 180));
      const alt = tr.elevationAt(engine.s) + (isBus ? 2.7 : p.sound === 'ship' ? 7.5 : 3.1);
      const opts = map.calculateCameraOptionsFromCameraLngLatAltRotation([camLon, camLat], alt, this.camBearing, 80);
      const c = LngLat.convert(opts.center!);
      target = { lng: c.lng, lat: c.lat, zoom: opts.zoom!, pitch: opts.pitch ?? 80, bearing: this.camBearing };
    } else if (mode === 'top') {
      const [la, lo] = tr.path.pointAt(engine.s - Math.min(L * 0.3, 30));
      const zoom = (p.sound === 'ship' ? 16.8 : isBus ? 18.4 : L > 150 ? 17.2 : 17.7) + this.zoomOffset;
      target = { lng: lo, lat: la, zoom, pitch: 0, bearing: headingUp ? this.camBearing : 0 };
      padding = { top: h * 0.22, bottom: 0, left: 0, right: 0 };
    } else {
      const [la, lo] = tr.path.pointAt(engine.s - (isBus ? 6 : 14));
      const zoom = (p.sound === 'ship' ? 17.4 : isBus ? 19.2 : L > 150 ? 18.3 : L > 60 ? 18.6 : 18.9) + this.zoomOffset;
      target = { lng: lo, lat: la, zoom, pitch: 64, bearing: this.camBearing + 20 };
      padding = { top: h * 0.3, bottom: 0, left: 0, right: 0 };
    }
    if (this.blend < 1 && this.blendFrom) {
      this.blend = Math.min(1, this.blend + dt / this.blendDur);
      const b = this.blend;
      const t = b < 0.5 ? 4 * b * b * b : 1 - Math.pow(-2 * b + 2, 3) / 2;
      const f = this.blendFrom;
      target = {
        lng: lerp(f.lng, target.lng, t),
        lat: lerp(f.lat, target.lat, t),
        zoom: lerp(f.zoom, target.zoom, t),
        pitch: lerp(f.pitch, target.pitch, t),
        bearing: f.bearing + angleDiff(f.bearing / DEG, target.bearing / DEG) * DEG * t,
      };
    }
    map.jumpTo({ center: [target.lng, target.lat], zoom: target.zoom, pitch: target.pitch, bearing: target.bearing, padding: mode === 'cab' ? { top: 0, bottom: 0, left: 0, right: 0 } : padding });
  }

  setCameraMode() {
    this.blend = 0;
    this.blendDur = 0.9;
    this.blendFrom = this.snap();
    this.zoomOffset = 0;
  }

  repaint() {
    this.map?.triggerRepaint();
  }
}

export const mapCtl = new MapController();
