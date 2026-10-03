import { getPosition, getTimes } from 'suncalc';
import type { TimeChoice } from '../../types';

export interface SunState {
  /** degrees above horizon */
  altitude: number;
  /** radians clockwise from north */
  bearing: number;
}

export function sunAt(utcMs: number, lat: number, lon: number): SunState {
  const p = getPosition(new Date(utcMs), lat, lon);
  return { altitude: (p.altitude * 180) / Math.PI, bearing: p.azimuth + Math.PI };
}

/**
 * Converts a "time of day" choice into a UTC start instant for the city.
 * Uses real sun times so "dusk" really is dusk in Reykjavík in June.
 */
export function startInstant(choice: TimeChoice, lat: number, lon: number, utcOffsetSec: number): number {
  const now = Date.now();
  if (choice === 'live') return now;
  const local = new Date(now + utcOffsetSec * 1000);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12) - utcOffsetSec * 1000;
  const t = getTimes(new Date(base), lat, lon);
  const at = (d: Date | null, offset: number, fallback: number) => (d && !isNaN(d.getTime()) ? d.getTime() + offset : fallback);
  switch (choice) {
    case 'dawn':
      return at(t.sunrise, -10 * 60e3, base - 5 * 3600e3);
    case 'day':
      return at(t.solarNoon, -90 * 60e3, base);
    case 'dusk':
      return at(t.sunset, -15 * 60e3, base + 6 * 3600e3);
    case 'night':
      return at(t.night, 30 * 60e3, base + 10 * 3600e3);
  }
}

export function localHour(utcMs: number, utcOffsetSec: number): number {
  const d = new Date(utcMs + utcOffsetSec * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

export function formatClock(utcMs: number, utcOffsetSec: number, seconds = false): string {
  const d = new Date(utcMs + utcOffsetSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!seconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}
