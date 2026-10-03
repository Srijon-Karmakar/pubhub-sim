export type Units = 'metric' | 'imperial';

export function speedValue(ms: number, u: Units): number {
  return u === 'metric' ? ms * 3.6 : ms * 2.23694;
}

export function speedUnit(u: Units): string {
  return u === 'metric' ? 'km/h' : 'mph';
}

export function distance(m: number, u: Units, precise = false): string {
  if (u === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft)} ft`;
    return `${(m / 1609.34).toFixed(precise ? 2 : 1)} mi`;
  }
  if (Math.abs(m) < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(precise ? 2 : 1)} km`;
}

export function shortDistance(m: number, u: Units): string {
  if (u === 'imperial') return `${Math.round(m * 3.28084)} ft`;
  return Math.abs(m) < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

export function mmss(sec: number): string {
  const neg = sec < 0;
  const s = Math.abs(Math.round(sec));
  return `${neg ? '−' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function signedMmss(sec: number): string {
  const s = Math.round(sec);
  if (Math.abs(s) < 1) return '±0:00';
  return `${s > 0 ? '+' : '−'}${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, '0')}`;
}

export function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
