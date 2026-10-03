import type { WeatherInfo, WeatherKind } from '../../types';
import { fetchJson } from '../osm/http';

function fromCode(code: number): WeatherKind {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

const memo = new Map<string, { t: number; v: WeatherInfo }>();

export async function fetchWeather(lat: number, lon: number): Promise<WeatherInfo> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const m = memo.get(key);
  if (m && Date.now() - m.t < 15 * 60e3) return m.v;
  try {
    const res = await fetchJson<{
      utc_offset_seconds: number;
      timezone: string;
      current: { weather_code: number; temperature_2m: number; wind_speed_10m: number };
    }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=weather_code,temperature_2m,wind_speed_10m&timezone=auto`,
      {},
      8000,
    );
    const v: WeatherInfo = {
      kind: fromCode(res.current.weather_code),
      temp: res.current.temperature_2m,
      wind: res.current.wind_speed_10m,
      utcOffset: res.utc_offset_seconds,
      timezone: res.timezone,
    };
    memo.set(key, { t: Date.now(), v });
    return v;
  } catch {
    return { kind: 'clear', temp: NaN, wind: 0, utcOffset: Math.round(lon / 15) * 3600 };
  }
}

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  fog: 'Fog',
  rain: 'Rain',
  storm: 'Storm',
  snow: 'Snow',
};
