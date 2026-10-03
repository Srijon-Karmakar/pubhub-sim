import { Cloud, CloudFog, CloudLightning, CloudRain, Moon, Snowflake, Sun } from 'lucide-react';
import type { WeatherKind } from '../types';

export function WeatherIcon({ kind, size = 16, night }: { kind: WeatherKind; size?: number; night?: boolean }) {
  const p = { size, strokeWidth: 2.2 };
  switch (kind) {
    case 'clear':
      return night ? <Moon {...p} /> : <Sun {...p} />;
    case 'cloudy':
      return <Cloud {...p} />;
    case 'fog':
      return <CloudFog {...p} />;
    case 'rain':
      return <CloudRain {...p} />;
    case 'storm':
      return <CloudLightning {...p} />;
    case 'snow':
      return <Snowflake {...p} />;
  }
}
