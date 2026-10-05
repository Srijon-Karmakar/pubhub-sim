import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { Palette } from '../lib/env/palette';
import { mixHex } from '../lib/color';
import { DEM_URL, DEM_ZOOM } from '../lib/env/dem';

const SRC = 'omt';
const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
const REG = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];
const ITAL = ['Noto Sans Italic'];

const zw = (pairs: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...pairs.flat()] as unknown as ExpressionSpecification;

const cls = (...c: string[]): ExpressionSpecification => ['in', ['get', 'class'], ['literal', c]];
const notTunnel: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel'];
const isTunnel: ExpressionSpecification = ['==', ['get', 'brunnel'], 'tunnel'];

export function buildLayers(p: Palette, buildingOpacity = 0.94): LayerSpecification[] {
  const road = (
    id: string,
    classes: string[],
    color: string,
    width: [number, number][],
    filterExtra: ExpressionSpecification = notTunnel,
    minzoom = 5,
    extra: Record<string, unknown> = {},
  ): LayerSpecification => ({
    id,
    type: 'line',
    source: SRC,
    'source-layer': 'transportation',
    minzoom,
    filter: ['all', cls(...classes), filterExtra],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': zw(width), ...extra },
  });

  return [
    { id: 'bg', type: 'background', paint: { 'background-color': p.bg } },
    {
      id: 'lc-wood',
      type: 'fill',
      source: SRC,
      'source-layer': 'landcover',
      filter: cls('wood', 'forest'),
      paint: { 'fill-color': p.wood, 'fill-opacity': 0.75 },
    },
    {
      id: 'lc-grass',
      type: 'fill',
      source: SRC,
      'source-layer': 'landcover',
      filter: cls('grass', 'wetland', 'farmland'),
      paint: { 'fill-color': p.grass, 'fill-opacity': 0.55 },
    },
    {
      id: 'lc-sand',
      type: 'fill',
      source: SRC,
      'source-layer': 'landcover',
      filter: cls('sand', 'beach'),
      paint: { 'fill-color': p.sand, 'fill-opacity': 0.8 },
    },
    {
      id: 'lu-res',
      type: 'fill',
      source: SRC,
      'source-layer': 'landuse',
      filter: cls('residential', 'suburb', 'neighbourhood'),
      paint: { 'fill-color': p.residential, 'fill-opacity': 0.7 },
    },
    {
      id: 'lu-ind',
      type: 'fill',
      source: SRC,
      'source-layer': 'landuse',
      filter: cls('industrial', 'commercial', 'retail', 'railway', 'garages'),
      paint: { 'fill-color': p.industrial, 'fill-opacity': 0.7 },
    },
    {
      id: 'lu-green',
      type: 'fill',
      source: SRC,
      'source-layer': 'landuse',
      filter: cls('cemetery', 'pitch', 'stadium', 'playground', 'park', 'golf_course'),
      paint: { 'fill-color': p.park, 'fill-opacity': 0.75 },
    },
    {
      id: 'park',
      type: 'fill',
      source: SRC,
      'source-layer': 'park',
      paint: { 'fill-color': p.park, 'fill-opacity': 0.85 },
    },
    {
      // relief shading from the terrain model: valleys and ridges read even from above
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem-hs',
      paint: {
        'hillshade-shadow-color': mixHex(p.bg, '#000000', 0.5),
        'hillshade-highlight-color': mixHex(p.bg, '#ffffff', 0.45),
        'hillshade-accent-color': mixHex(p.bg, '#000000', 0.3),
        'hillshade-exaggeration': 0.45,
        'hillshade-illumination-direction': 315,
      },
    },
    {
      id: 'water',
      type: 'fill',
      source: SRC,
      'source-layer': 'water',
      filter: notTunnel,
      paint: { 'fill-color': p.water },
    },
    {
      id: 'waterway',
      type: 'line',
      source: SRC,
      'source-layer': 'waterway',
      filter: notTunnel,
      paint: { 'line-color': p.waterLine, 'line-width': zw([[8, 0.5], [14, 2], [18, 8]]) },
    },
    {
      id: 'aeroway-area',
      type: 'fill',
      source: SRC,
      'source-layer': 'aeroway',
      minzoom: 11,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': p.runway, 'fill-opacity': 0.7 },
    },
    {
      id: 'aeroway-runway',
      type: 'line',
      source: SRC,
      'source-layer': 'aeroway',
      minzoom: 11,
      filter: ['all', ['==', ['geometry-type'], 'LineString'], cls('runway', 'taxiway')],
      paint: { 'line-color': p.runway, 'line-width': zw([[11, 2], [15, 18], [18, 60]]) },
    },
    road('road-tunnel', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], p.roadMinorCase, [[12, 0.5], [16, 4], [19, 14]], isTunnel, 12, {
      'line-dasharray': [1.5, 1.5],
      'line-opacity': 0.6,
    }),
    road('path', ['path', 'track'], p.path, [[14, 0.5], [18, 2.5]], notTunnel, 14, { 'line-dasharray': [2, 1.5] }),
    road('service-case', ['service'], p.roadMinorCase, [[13, 0.8], [16, 4], [19, 13]], notTunnel, 13),
    road('minor-case', ['minor', 'tertiary'], p.roadMinorCase, [[11, 0.8], [14, 3], [16, 8], [19, 26]], notTunnel, 11),
    road('major-case', ['primary', 'secondary'], p.roadMajorCase, [[8, 0.8], [12, 3], [16, 13], [19, 36]], notTunnel, 8),
    road('motorway-case', ['motorway', 'trunk'], p.motorwayCase, [[6, 0.8], [10, 3], [16, 16], [19, 42]], notTunnel, 6),
    road('service', ['service'], p.service, [[13, 0.4], [16, 2.8], [19, 10]], notTunnel, 13),
    road('minor', ['minor', 'tertiary'], p.roadMinor, [[11, 0.4], [14, 2], [16, 6], [19, 22]], notTunnel, 11),
    road('major', ['primary', 'secondary'], p.roadMajor, [[8, 0.5], [12, 2], [16, 10.5], [19, 32]], notTunnel, 8),
    road('motorway', ['motorway', 'trunk'], p.motorway, [[6, 0.5], [10, 2], [16, 13], [19, 37]], notTunnel, 6),
    road('rail', ['rail', 'transit'], p.rail, [[10, 0.5], [14, 1.2], [18, 3]], notTunnel, 10, { 'line-dasharray': [3, 2] }),
    {
      id: 'building',
      type: 'fill',
      source: SRC,
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-color': p.building,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 0.9],
      },
    },
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: SRC,
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        // a constant colour updates instantly on theme changes; data-driven colours keep stale tiles
        'fill-extrusion-color': mixHex(p.building, p.buildingTop, 0.45),
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 6]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': buildingOpacity,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'boundary',
      type: 'line',
      source: SRC,
      'source-layer': 'boundary',
      filter: ['<=', ['get', 'admin_level'], 4],
      paint: { 'line-color': p.boundary, 'line-width': 1, 'line-dasharray': [3, 2], 'line-opacity': 0.6 },
    },
    {
      id: 'water-name',
      type: 'symbol',
      source: SRC,
      'source-layer': 'water_name',
      layout: { 'text-field': NAME, 'text-font': ITAL, 'text-size': 12, 'text-max-width': 8 },
      paint: { 'text-color': p.waterLabel, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'road-name',
      type: 'symbol',
      source: SRC,
      'source-layer': 'transportation_name',
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': NAME,
        'text-font': REG,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 18, 13],
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': p.labelMinor, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'place-minor',
      type: 'symbol',
      source: SRC,
      'source-layer': 'place',
      minzoom: 11,
      filter: cls('suburb', 'neighbourhood', 'quarter', 'hamlet', 'village'),
      layout: {
        'text-field': NAME,
        'text-font': REG,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
        'text-max-width': 7,
      },
      paint: { 'text-color': p.labelMinor, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-town',
      type: 'symbol',
      source: SRC,
      'source-layer': 'place',
      minzoom: 8,
      filter: cls('town'),
      layout: { 'text-field': NAME, 'text-font': BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15] },
      paint: { 'text-color': p.label, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.5 },
    },
    {
      id: 'place-city',
      type: 'symbol',
      source: SRC,
      'source-layer': 'place',
      filter: cls('city'),
      layout: { 'text-field': NAME, 'text-font': BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 12, 12, 20] },
      paint: { 'text-color': p.label, 'text-halo-color': p.labelHalo, 'text-halo-width': 2 },
    },
  ] as LayerSpecification[];
}

export function buildStyle(p: Palette): StyleSpecification {
  return {
    version: 8,
    name: 'PublicPort',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [SRC]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      },
      // terrain model (3D ground) and a separate copy for hillshading, as MapLibre recommends
      dem: { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, maxzoom: DEM_ZOOM, encoding: 'terrarium', attribution: 'Terrain: Mapzen / AWS Terrain Tiles' },
      'dem-hs': { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, maxzoom: DEM_ZOOM, encoding: 'terrarium' },
    },
    sky: skyFor(p),
    light: { anchor: 'map', color: p.light, intensity: p.lightIntensity, position: [1.4, 210, 40] },
    layers: buildLayers(p),
  };
}

export function skyFor(p: Palette) {
  return {
    'sky-color': p.sky,
    'horizon-color': p.horizon,
    'fog-color': p.fog,
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': p.fogBlend,
    'atmosphere-blend': 0,
  };
}
