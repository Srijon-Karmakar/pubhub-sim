/**
 * Headless regression test for the OSM parser and driving engine.
 * An autopilot drives a real route (Kolkata Metro Blue Line fixture) end to end.
 *
 *   npm run test:sim
 *   npx tsx scripts/simtest.ts <overpass.json> <relationId> [mode]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRoute } from '../src/lib/osm/routeGeometry';
import { groupLines } from '../src/lib/osm/routes';
import { Engine } from '../src/lib/sim/engine';
import type { RouteRef } from '../src/types';

const fixture = fileURLToPath(new URL('./fixtures/kolkata-blue-line.json', import.meta.url));
const file = process.argv[2] ?? fixture;
const id = Number(process.argv[3] ?? 8033916);
const mode = (process.argv[4] ?? 'subway') as RouteRef['mode'];

const json = JSON.parse(readFileSync(file, 'utf8'));
const rel = json.elements.find((e: { type: string; id: number }) => e.type === 'relation' && e.id === id);
const ref: RouteRef = { id, mode, ref: rel.tags.ref, name: rel.tags.name, from: rel.tags.from, to: rel.tags.to, colour: rel.tags.colour, network: rel.tags.network };
const line = groupLines([ref])[0];
const route = await parseRoute(json.elements, ref, line, 1);

const e = new Engine({
  route,
  startIdx: 0,
  endIdx: route.stops.length - 1,
  clockStartUtc: Date.UTC(2026, 0, 1, 3),
  hourLocal: 8.5,
  weather: 'clear',
  autoDoors: false,
});
const p = e.profile;
console.log(`route: ${route.stops.length} stops, ${(e.track.length / 1000).toFixed(1)} km, ${e.track.limV.length} speed-limit segments, ${e.track.tunnels.length} tunnels`);

const dt = 1 / 30;
while (!e.finished && e.t < 4 * 3600) {
  const h = e.hud();
  const d = h.distToStop;
  if (h.served) {
    if (h.doors === 'open' && h.flowDone && h.departIn <= 1) e.toggleDoors();
    e.setNotch(h.doors === 'closed' && h.departIn <= 0 ? p.powerNotches : -p.brakeNotches);
  } else if (h.atp) {
    e.setNotch(0);
  } else if (h.canOpen && (Math.abs(d) < 0.8 || d < 0)) {
    e.toggleDoors();
    e.setNotch(-p.brakeNotches);
  } else if (e.v === 0 && d > 0.5 && d < 40) {
    e.setNotch(1);
  } else {
    let vt = h.limit - 1.2;
    if (h.nextLimit) vt = Math.min(vt, Math.sqrt(h.nextLimit.v ** 2 + 2 * 0.55 * p.brake * Math.max(0, h.nextLimit.dist - 25)));
    vt = Math.min(vt, Math.sqrt(2 * 0.55 * p.brake * Math.max(0, d - 1.5)), d < 4 ? 0.8 : 99);
    const err = vt - e.v;
    if (err > 1) e.setNotch(p.powerNotches);
    else if (err > 0.2) e.setNotch(1);
    else if (err > -0.3) e.setNotch(0);
    else e.setNotch(-Math.min(p.brakeNotches, Math.ceil(-err * 3)));
  }
  e.step(dt);
}

const missed = e.ratings.filter((r) => r.grade === 'missed').length;
console.log(`finished=${e.finished} time=${Math.round(e.t)}s (timetable ${e.tt.arr[e.tt.arr.length - 1]}s) score=${Math.round(e.score)}/${e.maxScore}`);
console.log(`comfort=${Math.round(e.avgComfort)} pax=${e.paxDelivered} atp=${e.atpCount} overspeed=${e.overspeedT.toFixed(1)}s missed=${missed}`);
console.log('breakdown:', [...e.breakdown.entries()].map(([k, v]) => `${k} ${Math.round(v)}`).join(', '));

const failures: string[] = [];
if (route.stops.length < 20) failures.push(`expected >= 20 stops, got ${route.stops.length}`);
if (!e.finished) failures.push('run did not finish');
if (missed > 0) failures.push(`${missed} stops missed`);
if (e.atpCount > 0) failures.push('ATP intervened');
if (Math.abs(e.t - e.tt.arr[e.tt.arr.length - 1]) > 240) failures.push('timetable is not achievable by a careful driver');
if (e.score < e.maxScore * 0.5) failures.push('score unexpectedly low');
if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('PASS');
